import { useFilesTab } from "./files-tab/useFilesTab";
import { UploadPanel } from "./files-tab/UploadPanel";
import { ReaderTocPanel } from "./files-tab/ReaderTocPanel";
import { FilesList } from "./files-tab/FilesList";
import { ChapterPreview } from "./files-tab/ChapterPreview";
import { GeneratedIndex } from "./files-tab/GeneratedIndex";
import { JsonIndexes } from "./files-tab/JsonIndexes";

export function FilesTab({ bookId }: { bookId: string }) {
  const state = useFilesTab(bookId);
  return (
    <div>
      <UploadPanel state={state} />
      <ReaderTocPanel state={state} />
      <FilesList state={state} />
      <ChapterPreview state={state} />
      <GeneratedIndex state={state} />
      <JsonIndexes state={state} />
    </div>
  );
}
