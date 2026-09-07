"use strict";
var __createBinding = (this && this.__createBinding) || (Object.create ? (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    var desc = Object.getOwnPropertyDescriptor(m, k);
    if (!desc || ("get" in desc ? !m.__esModule : desc.writable || desc.configurable)) {
      desc = { enumerable: true, get: function() { return m[k]; } };
    }
    Object.defineProperty(o, k2, desc);
}) : (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    o[k2] = m[k];
}));
var __setModuleDefault = (this && this.__setModuleDefault) || (Object.create ? (function(o, v) {
    Object.defineProperty(o, "default", { enumerable: true, value: v });
}) : function(o, v) {
    o["default"] = v;
});
var __importStar = (this && this.__importStar) || (function () {
    var ownKeys = function(o) {
        ownKeys = Object.getOwnPropertyNames || function (o) {
            var ar = [];
            for (var k in o) if (Object.prototype.hasOwnProperty.call(o, k)) ar[ar.length] = k;
            return ar;
        };
        return ownKeys(o);
    };
    return function (mod) {
        if (mod && mod.__esModule) return mod;
        var result = {};
        if (mod != null) for (var k = ownKeys(mod), i = 0; i < k.length; i++) if (k[i] !== "default") __createBinding(result, mod, k[i]);
        __setModuleDefault(result, mod);
        return result;
    };
})();
Object.defineProperty(exports, "__esModule", { value: true });
exports.PdfEditorProvider = void 0;
const path = __importStar(require("node:path"));
const os = __importStar(require("node:os"));
const vscode = __importStar(require("vscode"));
const constants_1 = require("./constants");
const capabilities_1 = require("./features/capabilities");
const messages_1 = require("./validation/messages");
class PdfEditorProvider {
    context;
    saveManager;
    static viewType = constants_1.PDF_STUDIO_VIEW_TYPE;
    webviewsByDocument = new Map();
    constructor(context, saveManager) {
        this.context = context;
        this.saveManager = saveManager;
    }
    async openCustomDocument(uri) {
        await this.saveManager.getPdfBytes(uri);
        return {
            uri,
            dispose: () => {
                this.saveManager.disposeSession(uri);
            },
        };
    }
    async resolveCustomEditor(document, webviewPanel) {
        const documentKey = document.uri.toString();
        const webviews = this.webviewsByDocument.get(documentKey) ?? new Set();
        webviews.add(webviewPanel.webview);
        this.webviewsByDocument.set(documentKey, webviews);
        webviewPanel.webview.options = {
            enableScripts: true,
            localResourceRoots: [this.context.extensionUri],
        };
        webviewPanel.webview.html = this.getHtmlForWebview(webviewPanel.webview);
        webviewPanel.webview.onDidReceiveMessage(async (rawMessage) => {
            const message = (0, messages_1.parseWebviewMessage)(rawMessage);
            if (!message) {
                return;
            }
            switch (message.type) {
                case 'ready': {
                    await this.postInitialState(document.uri, webviewPanel.webview);
                    break;
                }
                case 'documentChanged': {
                    await this.handleDocumentSave(document.uri, message.payload.annotations, message.payload.formFields, webviewPanel.webview);
                    break;
                }
                case 'buttonActivated': {
                    await this.handleButtonActivated(document.uri, message.payload.name, message.payload.annotations, message.payload.formFields, webviewPanel.webview);
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
    async notifyCommentAuthorChanged() {
        const commentAuthor = this.resolveCommentAuthor();
        const message = {
            type: 'commentAuthorUpdated',
            payload: {
                commentAuthor,
            },
        };
        const deliveries = [];
        for (const webviews of this.webviewsByDocument.values()) {
            for (const webview of webviews) {
                deliveries.push(webview.postMessage(message));
            }
        }
        await Promise.all(deliveries);
    }
    async notifyInputPolicyChanged() {
        const message = {
            type: 'inputPolicyUpdated',
            payload: {
                allowFingerDrawing: this.resolveAllowFingerDrawing(),
            },
        };
        const deliveries = [];
        for (const webviews of this.webviewsByDocument.values()) {
            for (const webview of webviews) {
                deliveries.push(webview.postMessage(message));
            }
        }
        await Promise.all(deliveries);
    }
    async postInitialState(uri, webview) {
        try {
            const pdfBuffer = await this.saveManager.getPdfBytes(uri);
            const livePdfBuffer = await this.saveManager.getLivePdfBytes(uri);
            const annotations = await this.saveManager.getAnnotations(uri);
            const formFields = await this.saveManager.getFormFields(uri);
            const commentAuthor = this.resolveCommentAuthor();
            const allowFingerDrawing = this.resolveAllowFingerDrawing();
            const message = {
                type: 'init',
                payload: {
                    fileName: path.basename(uri.fsPath),
                    pdfBase64: Buffer.from(pdfBuffer).toString('base64'),
                    outlinePdfBase64: Buffer.from(livePdfBuffer).toString('base64'),
                    commentAuthor,
                    allowFingerDrawing,
                    annotations,
                    formFields,
                    capabilities: (0, capabilities_1.createDefaultCapabilities)(),
                },
            };
            webview.postMessage(message);
        }
        catch (error) {
            await this.postError(webview, error);
        }
    }
    async handleDocumentSave(uri, annotations, formFields, webview) {
        try {
            await this.saveManager.saveDocument(uri, annotations, formFields);
            await this.postSaved(webview);
        }
        catch (error) {
            await this.postError(webview, error);
        }
    }
    async handleButtonActivated(uri, buttonName, annotations, formFields, webview) {
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
                });
                await this.postSaved(webview);
                return;
            }
            await this.executeButtonAction(action, formFields);
            await this.postSaved(webview);
        }
        catch (error) {
            await this.postError(webview, error);
        }
    }
    async executeButtonAction(action, formFields) {
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
                throw new Error(action.reason || 'This PDF button uses an unsupported action.');
            case 'reset':
                return;
            default:
                throw new Error('This PDF button does not expose a supported action.');
        }
    }
    async postError(webview, error) {
        const message = {
            type: 'error',
            payload: {
                message: error instanceof Error ? error.message : 'Unknown error',
            },
        };
        await webview.postMessage(message);
    }
    async postSaved(webview) {
        const message = {
            type: 'saved',
            payload: {
                savedAt: new Date().toISOString(),
            },
        };
        await webview.postMessage(message);
    }
    resolveCommentAuthor() {
        const configured = vscode.workspace
            .getConfiguration('pdfStudio')
            .get('commentAuthor')
            ?.trim();
        if (configured) {
            return configured;
        }
        try {
            const osUser = os.userInfo().username?.trim();
            if (osUser) {
                return osUser;
            }
        }
        catch {
            // Fall through to the extension default below.
        }
        return 'PDF Studio';
    }
    resolveAllowFingerDrawing() {
        return vscode.workspace
            .getConfiguration('pdfStudio')
            .get('allowFingerDrawing', false);
    }
    getHtmlForWebview(webview) {
        const nonce = getNonce();
        const toWebviewUri = (segments) => webview
            .asWebviewUri(vscode.Uri.joinPath(this.context.extensionUri, ...segments))
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
exports.PdfEditorProvider = PdfEditorProvider;
function getNonce() {
    const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
    let value = '';
    for (let index = 0; index < 32; index += 1) {
        value += chars.charAt(Math.floor(Math.random() * chars.length));
    }
    return value;
}
//# sourceMappingURL=PdfEditorProvider.js.map