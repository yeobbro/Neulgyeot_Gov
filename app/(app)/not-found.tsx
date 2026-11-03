import Link from "next/link";
export default function NotFound() {
  return (
    <div className="panel"><div className="panel-body stack">
      <h1>찾을 수 없습니다</h1>
      <p>요청한 정보가 없거나 열람 권한 범위 밖입니다.</p>
      <p><Link href="/">처음 화면으로</Link></p>
    </div></div>
  );
}
