// ダッシュボードの repo セクションの並び。ダッシュボードから使う。
// DOM も chrome.* も使わないので Node の単体テスト (test/repo-order.test.mjs) から回せる。

// run の時刻。各 repo の中の並びと同じく、行の relative-time (`at`) が無ければ取得時刻 (`seenAt`)
export const runTime = r => String(r.at || r.seenAt || '');

// [[repo, runs], …] (設定の順) を、直近に run が動いた repo が上になるよう並べ替えた新しい配列で返す。
// 時刻は ISO 文字列なので文字列比較で足りる。run が無い repo (読み込み中) は末尾、
// 同時刻・どちらも時刻が無いときは元の順 (= 設定の順) を保つ (Array.prototype.sort は安定)。
export function sortReposByRecent(entries) {
  const latest = new Map(entries.map(([repo, runs]) =>
    [repo, runs.reduce((m, r) => (runTime(r) > m ? runTime(r) : m), '')]));
  return [...entries].sort(([a], [b]) => latest.get(b).localeCompare(latest.get(a)));
}
