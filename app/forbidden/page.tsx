import Link from "next/link";
export default function Forbidden() {
  return (
    <main className="content" style={{ maxWidth: 560, margin: "80px auto" }}>
      <div className="panel"><div className="panel-body stack">
        <h1>접근 권한이 없습니다</h1>
        <p>현재 계정의 역할로는 이 화면을 볼 수 없습니다. 필요한 경우 소속 지자체 관리자에게 권한을 요청하세요.</p>
        <p><Link href="/">처음 화면으로</Link></p>
      </div></div>
    </main>
  );
}
