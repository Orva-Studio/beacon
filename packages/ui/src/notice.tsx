import { Button, Modal } from "./controls";
import { replica, useView } from "./store";

/** A message to read and dismiss, with an optional list (what a `.cmproj` import left out). */
export function NoticeUi() {
  const notice = useView((v) => v.notice);
  if (!notice) return null;
  const close = () => replica.notice(undefined);
  return (
    <Modal title={notice.title} width={520} onClose={close} onEnter={close}>
      <p className="mb-3 text-text">{notice.message}</p>
      {notice.lines && (
        <ul className="mb-4 max-h-64 list-disc overflow-y-auto pl-5 text-text-muted">
          {notice.lines.map((l) => (
            <li key={l}>{l}</li>
          ))}
        </ul>
      )}
      <div className="flex justify-end">
        <Button onClick={close}>OK</Button>
      </div>
    </Modal>
  );
}
