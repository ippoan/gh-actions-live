// GitHub のログイン状態を Actions ページの HTML から読む (純粋 module。DOM は引数で受ける)。
// 同じセレクタを linux-browser/github-login.mjs:28 と github-logout.mjs:19 が CDP の文字列で持つ。
//
// ログインが切れると socket URL も embeddedData も無くなり、run の変化が来なくなる。
// dashboard.js の boot が 1 周ごとに判定し、変わったときだけ bridge へ {type:'login'} を送る
// (bridge は /watch のセッションへ 1 行流す)。GitHub の API は叩かない。

// meta[name=user-login] の content。空 / 無しは null (未ログインの GitHub の HTML は content="" を持つ)
export function loginOf(doc) {
  const v = doc?.querySelector('meta[name=user-login]')?.content;
  return typeof v === 'string' && v !== '' ? v : null;
}

// boot 1 周の結論。docs は判定に入れる doc (読み込めたページ、または 404 の本文) だけ。
// 1 つでも名前があればログイン済み (その user)、全部 null なら未ログイン、0 件なら判定しない (null)
export function loginVerdict(docs) {
  if (!docs.length) return null;
  for (const d of docs) {
    const user = loginOf(d);
    if (user) return { loggedIn: true, user };
  }
  return { loggedIn: false, user: null };
}

// observe(user): user は文字列か null。loggedIn (user !== null) が前回と変わったときだけ
// { loggedIn, user } を返し、同じなら null。初回は必ず返す。last() は最後の { loggedIn, user }
export function createLoginTracker() {
  let last = null;
  return {
    observe(user) {
      const next = { loggedIn: user !== null, user };
      const changed = !last || last.loggedIn !== next.loggedIn;
      last = next;
      return changed ? next : null;
    },
    last: () => last
  };
}
