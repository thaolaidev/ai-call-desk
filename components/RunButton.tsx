import { toggleRunning } from "@/app/(app)/actions";

export function RunButton({ running }: { running: boolean }) {
  return (
    <form action={toggleRunning}>
      <button className={`btn ${running ? "stop" : "primary"}`}>{running ? "หยุดโทรชั่วคราว" : "เริ่มโทร"}</button>
    </form>
  );
}
