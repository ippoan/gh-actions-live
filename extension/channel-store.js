// alive の購読トークン (data-channel) を repo ごとに持つための純粋関数。
// dashboard.js から使う。DOM に依存しないので Node の単体テストで回せる (test/channel-store.test.mjs)。
//
// なぜ repo ごとなのか (#c135-26): 以前は 1 本の Map に足すだけで、完了した run の
// トピックも残り続け、見張る repo と run が増えるほど購読が膨らんで 1009 (Message Too Big)
// で切られていた。repo の Actions ページを読み直すたびに「その repo の分」を作り直せば、
// もう出てこない run のトピックは自然に落ちる。

// entries: [[topic, token], ...] その repo の読み込み結果に今出ている全トピック。
// 足すのではなく作り直す (古いトピックは消える)
export function replaceRepoChannels(tokenByTopicByRepo, repo, entries) {
  tokenByTopicByRepo.set(repo, new Map(entries));
}

// 部分読み込み (1 run だけの refresh) 用。その repo の一覧全体を表さないので、
// 既存の分は消さずに足すだけ
export function mergeRepoChannels(tokenByTopicByRepo, repo, entries) {
  let m = tokenByTopicByRepo.get(repo);
  if (!m) { m = new Map(); tokenByTopicByRepo.set(repo, m); }
  for (const [topic, token] of entries) m.set(topic, token);
}

// 見張る repo の一覧から外れた repo の分を捨てる (set-config で repo を減らしたとき)
export function dropReposNotIn(tokenByTopicByRepo, keepRepos) {
  const keep = new Set(keepRepos);
  for (const repo of [...tokenByTopicByRepo.keys()]) {
    if (!keep.has(repo)) tokenByTopicByRepo.delete(repo);
  }
}

// repo ごとの Map を合わせた全体 (topic -> token)。購読に渡す全体・subscribedTopics の
// カウントに使う
export function allTokens(tokenByTopicByRepo) {
  const merged = new Map();
  for (const perRepo of tokenByTopicByRepo.values()) {
    for (const [topic, token] of perRepo) merged.set(topic, token);
  }
  return merged;
}

// topic -> repo の逆引き (alive-message が来たときにどの repo の分か知るため)
export function repoForTopic(tokenByTopicByRepo, topic) {
  for (const [repo, perRepo] of tokenByTopicByRepo) {
    if (perRepo.has(topic)) return repo;
  }
  return null;
}
