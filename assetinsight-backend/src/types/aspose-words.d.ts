declare module "@aspose/words" {
  class Document {
    constructor();
    constructor(fileName: string);
    constructor(data: Buffer);
    appendDocument(srcDoc: Document, importFormatMode: ImportFormatMode): void;
    appendDocument(
      srcDoc: Document,
      importFormatMode: ImportFormatMode,
      importFormatOptions: ImportFormatOptions
    ): void;
    save(fileName: string): unknown;
    save(fileName: string, saveFormat: SaveFormat): unknown;
    save(stream: unknown, saveFormat: SaveFormat): unknown;
  }

  class License {
    setLicense(license: string | Buffer): void;
  }

  class ImportFormatOptions {
    smartStyleBehavior: boolean;
    keepSourceNumbering: boolean;
    ignoreTextBoxes: boolean;
    ignoreHeaderFooter: boolean;
    mergePastedLists: boolean;
    forceCopyStyles: boolean;
    adjustSentenceAndWordSpacing: boolean;
    appendDocumentWithNewPage: boolean;
  }

  enum ImportFormatMode {
    UseDestinationStyles = 0,
    KeepSourceFormatting = 1,
    KeepDifferentStyles = 2,
  }

  enum SaveFormat {
    Docx = 20,
  }

  const aw: {
    Document: typeof Document;
    License: typeof License;
    ImportFormatOptions: typeof ImportFormatOptions;
    ImportFormatMode: typeof ImportFormatMode;
    SaveFormat: typeof SaveFormat;
  };

  export = aw;
}
