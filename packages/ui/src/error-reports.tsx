import { useState } from "react";
import { Button, Toast } from "./controls";
import type { SettingsPatch } from "@beacon/model";
import { useView } from "./store";

/** What every error report holds and leaves out: the first-run notice and Settings › General say the same. */
export const ERROR_REPORTS_TEXT =
  "Sends what broke and where in Beacon's code. Never your files, their names, folders or keys.";

/** The first-run notice that error reports are on (release builds), until it is answered: OK, or Turn Off. */
export function ErrorReportsNotice({ host }: { host: { setAppSettings(patch: SettingsPatch): void } }) {
  const notice = useView((v) => v.init?.errorReportsNotice);
  const [answered, setAnswered] = useState(false);
  if (!notice || answered) return null;
  const answer = (on: boolean) => {
    host.setAppSettings({ errorReportsNoticed: true, ...(on ? {} : { errorReports: false }) });
    setAnswered(true);
  };
  return (
    <Toast title="Error reports" done={false}>
      <div className="flex flex-col gap-2" data-error-reports-notice>
        <span className="text-text">{ERROR_REPORTS_TEXT} Turn off here or in Settings › General.</span>
        <div className="flex justify-end gap-2">
          <Button onClick={() => answer(false)} data-error-reports-off>
            Turn Off
          </Button>
          <Button look="primary" onClick={() => answer(true)} data-error-reports-ok>
            OK
          </Button>
        </div>
      </div>
    </Toast>
  );
}
