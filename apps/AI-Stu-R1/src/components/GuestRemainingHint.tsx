export const GUEST_REMAINING_SCOPE = "此為本裝置／目前網路的訪客剩餘次數，不是個人帳號額度。";

export function GuestRemainingHint({ remaining }: { remaining?: number | null }) {
  return (
    <span>
      訪客剩餘次數：{remaining == null ? "尚無資料（送出訪客問題後更新）" : remaining}。{GUEST_REMAINING_SCOPE}登入後使用此公開訪客問答，仍計入目前網路的訪客次數。
    </span>
  );
}
