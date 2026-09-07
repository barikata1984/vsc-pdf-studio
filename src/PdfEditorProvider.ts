import * as path from 'node:path';
import * as os from 'node:os';
import * as vscode from 'vscode';
import type { AnnotationDocument } from '../models/annotation';
import type { PdfButtonAction, PdfFormField } from '../models/formField';
import { PDF_STUDIO_VIEW_TYPE } from './constants';
import { createDefaultCapabilities } from './features/capabilities';
import type { ExtensionToWebviewMessage } from './messaging';
import { parseWebviewMessage } from './validation/messages';
import { SaveManager } from '../storage/saveManager';

export class PdfEditorProvider implements vscode.CustomReadonlyEditorProvider {
  public static readonly viewType = PDF_STUDIO_VIEW_TYPE;
  private readonly webviewsByDocument = new Map<string, Set<vscode.Webview>>();

  public constructor(
    private readonly context: vscode.ExtensionContext,
    private readonly saveManager: SaveManager
  ) {}

  public async openCustomDocument(
    uri: vscode.Uri
  ): Promise<vscode.CustomDocument> {
    await this.saveManager.getPdfBytes(uri);

    return {
      uri,
      dispose: () => {
        this.saveManager.disposeSession(uri);
      },
    };
  }

  public async resolveCustomEditor(
    document: vscode.CustomDocument,
    webviewPanel: vscode.WebviewPanel
  ): Promise<void> {
    const documentKey = document.uri.toString();
    const webviews =
      this.webviewsByDocument.get(documentKey) ?? new Set<vscode.Webview>();
    webviews.add(webviewPanel.webview);
    this.webviewsByDocument.set(documentKey, webviews);

    webviewPanel.webview.options = {
      enableScripts: true,
      localResourceRoots: [this.context.extensionUri],
    };

    webviewPanel.webview.html = this.getHtmlForWebview(webviewPanel.webview);

    webviewPanel.webview.onDidReceiveMessage(async (rawMessage: unknown) => {
      const message = parseWebviewMessage(rawMessage);
      if (!message) {
        return;
      }

      switch (message.type) {
        case 'ready': {
          await this.postInitialState(document.uri, webviewPanel.webview);
          break;
        }
        case 'documentChanged': {
          await this.handleDocumentSave(
            document.uri,
            message.payload.annotations,
            message.payload.formFields,
            webviewPanel.webview
          );
          break;
        }
        case 'buttonActivated': {
          await this.handleButtonActivated(
            document.uri,
            message.payload.name,
            message.payload.annotations,
            message.payload.formFields,
            webviewPanel.webview
          );
          break;
        }
      }
    });

    webviewPanel.onDidDispose(() => {
      const views = this.webviewsByDocument.get(documentKey);
      if (!views) {
        return;
      }

      views.delete(webviewPanel.webview);
      if (!views.size) {
        this.webviewsByDocument.delete(documentKey);
      }
    });
  }

  public async notifyCommentAuthorChanged(): Promise<void> {
    const commentAuthor = this.resolveCommentAuthor();
    const message: ExtensionToWebviewMessage = {
      type: 'commentAuthorUpdated',
      payload: {
        commentAuthor,
      },
    };

    const deliveries: Array<Thenable<boolean>> = [];
    for (const webviews of this.webviewsByDocument.values()) {
      for (const webview of webviews) {
        deliveries.push(webview.postMessage(message));
      }
    }

    await Promise.all(deliveries);
  }

  public async notifyInputPolicyChanged(): Promise<void> {
    const message: ExtensionToWebviewMessage = {
      type: 'inputPolicyUpdated',
      payload: {
        allowFingerDrawing: this.resolveAllowFingerDrawing(),
      },
    };

    const deliveries: Array<Thenable<boolean>> = [];
    for (const webviews of this.webviewsByDocument.values()) {
      for (const webview of webviews) {
        deliveries.push(webview.postMessage(message));
      }
    }

    await Promise.all(deliveries);
  }

  private async postInitialState(
    uri: vscode.Uri,
    webview: vscode.Webview
  ): Promise<void> {
    try {
      const pdfBuffer = await this.saveManager.getPdfBytes(uri);
      const livePdfBuffer = await this.saveManager.getLivePdfBytes(uri);
      const annotations = await this.saveManager.getAnnotations(uri);
      const formFields = await this.saveManager.getFormFields(uri);
      const commentAuthor = this.resolveCommentAuthor();
      const allowFingerDrawing = this.resolveAllowFingerDrawing();

      const message: ExtensionToWebviewMessage = {
        type: 'init',
        payload: {
          fileName: path.basename(uri.fsPath),
          pdfBase64: Buffer.from(pdfBuffer).toString('base64'),
          outlinePdfBase64: Buffer.from(livePdfBuffer).toString('base64'),
          commentAuthor,
          allowFingerDrawing,
          annotations,
          formFields,
          capabilities: createDefaultCapabilities(),
        },
      };

      webview.postMessage(message);
    } catch (error) {
      await this.postError(webview, error);
    }
  }

  private async handleDocumentSave(
    uri: vscode.Uri,
    annotations: AnnotationDocument,
    formFields: PdfFormField[],
    webview: vscode.Webview
  ): Promise<void> {
    try {
      await this.saveManager.saveDocument(uri, annotations, formFields);
      await this.postSaved(webview);
    } catch (error) {
      await this.postError(webview, error);
    }
  }

  private async handleButtonActivated(
    uri: vscode.Uri,
    buttonName: string,
    annotations: AnnotationDocument,
    formFields: PdfFormField[],
    webview: vscode.Webview
  ): Promise<void> {
    try {
      const action = await this.saveManager.getButtonAction(uri, buttonName);
      if (!action) {
        throw new Error('This PDF button does not expose a supported action.');
      }

      await this.saveManager.saveDocument(uri, annotations, formFields);

      if (action.type === 'reset') {
        const resetFormFields = await this.saveManager.getResetFormFields(uri);
        await this.saveManager.saveDocument(uri, annotations, resetFormFields);
        await webview.postMessage({
          type: 'formFieldsReplaced',
          payload: {
            formFields: resetFormFields,
          },
        } satisfies ExtensionToWebviewMessage);
        await this.postSaved(webview);
        return;
      }

      await this.executeButtonAction(action, formFields);
      await this.postSaved(webview);
    } catch (error) {
      await this.postError(webview, error);
    }
  }

  private async executeButtonAction(
    action: PdfButtonAction,
    formFields: PdfFormField[]
  ): Promise<void> {
    switch (action.type) {
      case 'submit':
        await this.saveManager.submitForm(formFields, action);
        return;
      case 'mailto':
      case 'uri':
        if (!action.url) {
          throw new Error('This PDF button does not expose a usable target.');
        }
        await vscode.env.openExternal(vscode.Uri.parse(action.url));
        return;
      case 'unsupported':
        throw new Error(
          action.reason || 'This PDF button uses an unsupported action.'
        );
      case 'reset':
        return;
      default:
        throw new Error('This PDF button does not expose a supported action.');
    }
  }

  private async postError(
    webview: vscode.Webview,
    error: unknown
  ): Promise<void> {
    const message: ExtensionToWebviewMessage = {
      type: 'error',
      payload: {
        message: error instanceof Error ? error.message : 'Unknown error',
      },
    };

    await webview.postMessage(message);
  }

  private async postSaved(webview: vscode.Webview): Promise<void> {
    const message: ExtensionToWebviewMessage = {
      type: 'saved',
      payload: {
        savedAt: new Date().toISOString(),
      },
    };

    await webview.postMessage(message);
  }

  private resolveCommentAuthor(): string {
    const configured = vscode.workspace
      .getConfiguration('pdfStudio')
      .get<string>('commentAuthor')
      ?.trim();
    if (configured) {
      return configured;
    }

    try {
      const osUser = os.userInfo().username?.trim();
      if (osUser) {
        return osUser;
      }
    } catch {
      // Fall through to the extension default below.
    }

    return 'PDF Studio';
  }

  private resolveAllowFingerDrawing(): boolean {
    return vscode.workspace
      .getConfiguration('pdfStudio')
      .get<boolean>('allowFingerDrawing', false);
  }

  private getHtmlForWebview(webview: vscode.Webview): string {
    const nonce = getNonce();
    const toWebviewUri = (segments: string[]): string =>
      webview
        .asWebviewUri(
          vscode.Uri.joinPath(this.context.extensionUri, ...segments)
        )
        .toString();
    const pdfWorkerUri = toWebviewUri(['media', 'libs', 'pdf.worker.min.js']);

    const html = [
      '<!DOCTYPE html>',
      '<html lang="en">',
      '<head>',
      '  <meta charset="UTF-8" />',
      `  <meta http-equiv="Content-Security-Policy" content="default-src 'none'; img-src ${webview.cspSource} blob: data:; style-src ${webview.cspSource} 'unsafe-inline'; script-src 'nonce-${nonce}' ${webview.cspSource}; worker-src ${webview.cspSource} blob:; font-src ${webview.cspSource};">`,
      '  <meta name="viewport" content="width=device-width, initial-scale=1.0" />',
      `  <link rel="stylesheet" href="${toWebviewUri(['media', 'styles.css'])}" />`,
      `  <script nonce="${nonce}" src="${toWebviewUri(['media', 'libs', 'pdf.min.js'])}"></script>`,
      `  <script nonce="${nonce}">globalThis.pdfjsLib.GlobalWorkerOptions.workerSrc = ${JSON.stringify(pdfWorkerUri)};</script>`,
      `  <script nonce="${nonce}" src="${toWebviewUri(['media', 'libs', 'pdf_viewer.js'])}"></script>`,
      '</head>',
      '<body>',
      '  <div id="app"></div>',
      `  <script nonce="${nonce}" type="module" src="${toWebviewUri(['media', 'main.js'])}"></script>`,
      '</body>',
      '</html>',
    ].join('\n');

    return html;
  }
}

function getNonce(): string {
  const chars =
    'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
  let value = '';

  for (let index = 0; index < 32; index += 1) {
    value += chars.charAt(Math.floor(Math.random() * chars.length));
  }

  return value;
}
