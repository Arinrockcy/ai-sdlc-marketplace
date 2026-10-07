import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseCommandLine, parsePackageSpec, canonicalNpmCommand } from '../scripts/guardian.mjs';

const CWD = '/work/app';

// A compact view of an action: only what differs from the default is listed.
function brief(a) {
  const out = { tool: a.tool, command: a.command, dir: a.dir, packages: a.packages.map((p) => `${p.alias ? `${p.alias}=` : ''}${p.name}${p.range ? `@${p.range}` : ''}`) };
  if (a.via) out.via = a.via;
  if (a.global) out.global = true;
  if (a.workspaces.length) out.workspaces = a.workspaces;
  if (a.allWorkspaces) out.allWorkspaces = true;
  if (a.includeWorkspaceRoot) out.includeWorkspaceRoot = true;
  if (a.force) out.force = true;
  return out;
}
const npm = (command, packages = [], extra = {}) => ({ tool: 'npm', command, dir: CWD, packages, ...extra });
const npx = (packages, extra = {}) => ({ tool: 'npx', command: 'exec', dir: CWD, packages, ...extra });

function check(cases) {
  for (const [line, actions, kinds = [], cwd = CWD] of cases) {
    const r = parseCommandLine(line, { cwd });
    assert.deepEqual(r.actions.map(brief), actions, `actions of: ${line}`);
    assert.deepEqual(r.unjudgeable.map((u) => u.kind), kinds, `unjudgeable of: ${line}${r.unjudgeable.length ? ` (${r.unjudgeable.map((u) => u.reason).join('; ')})` : ''}`);
  }
}

test('parser: commands that do not change dependencies produce nothing, and chains keep only the npm segments', () => {
  check([
    ['', []],
    ['   # just a comment', []],
    ['ls -la && git status', []],
    ['npm test', []],
    ['npm run build -- --watch', []],
    ['npm ls --all', []],
    ['npm audit', []],
    ['npm audit signatures', []],
    ['npm uninstall lodash', []],
    ['npm view lodash version', []],
    ['npm config set registry https://registry.npmjs.org/', []],
    ['npm install && npm test', [npm('install', [])]],
    ['npm ci && npm run lint && npm test', [npm('ci', [])]],
    ['npm test; npm i lodash', [npm('install', ['lodash'])]],
    ['npm i a && npm i b || echo failed', [npm('install', ['a']), npm('install', ['b'])]],
    ['npm i a\nnpm i b', [npm('install', ['a']), npm('install', ['b'])]],
    ['npm i a & npm i b', [npm('install', ['a']), npm('install', ['b'])]],
    ['echo "npm install evil"', []],
    ["echo 'npm install evil'", []],
    ['cat package.json | grep npm', []],
  ]);
});

test('parser: install, update, ci and audit fix under every spelling npm accepts', () => {
  check([
    ['npm install lodash', [npm('install', ['lodash'])]],
    ['npm i lodash', [npm('install', ['lodash'])]],
    ['npm add lodash', [npm('install', ['lodash'])]],
    ['npm isntall lodash', [npm('install', ['lodash'])]],
    ['npm INSTALL lodash', [npm('install', ['lodash'])]],
    ['npm install-test lodash', [npm('install', ['lodash'])]],
    ['npm it lodash', [npm('install', ['lodash'])]],
    ['npm inst lodash', [npm('install', ['lodash'])]],
    ['npm instal lodash', [npm('install', ['lodash'])]],
    ['npm update', [npm('update')]],
    ['npm up lodash', [npm('update', ['lodash'])]],
    ['npm upgrade', [npm('update')]],
    ['npm upd', [npm('update')]],
    ['npm ci', [npm('ci')]],
    ['npm clean-install', [npm('ci')]],
    ['npm cit', [npm('ci')]],
    ['npm audit fix', [npm('audit-fix')]],
    ['npm audit fix --force', [npm('audit-fix', [], { force: true })]],
    ['npm audit fix --no-force', [npm('audit-fix')]],
    ['npm audit fix -f', [npm('audit-fix', [], { force: true })]],
    ['npm.cmd install lodash', [npm('install', ['lodash'])]],
    ['/usr/local/bin/npm i lodash', [npm('install', ['lodash'])]],
    ['./node_modules/.bin/npm i lodash', [npm('install', ['lodash'])]],
    // An ambiguous abbreviation is an npm error, so nothing runs.
    ['npm u lodash', []],
    ['npm ad lodash', []],
  ]);
});

test('parser: packages, scopes, ranges, tags, aliases and quoting', () => {
  check([
    ['npm i lodash express', [npm('install', ['lodash', 'express'])]],
    ['npm i lodash@4.17.21', [npm('install', ['lodash@4.17.21'])]],
    ['npm i lodash@latest', [npm('install', ['lodash@latest'])]],
    ['npm i lodash@', [npm('install', ['lodash'])]],
    ['npm i @types/node', [npm('install', ['@types/node'])]],
    ['npm i @types/node@^20.1.0', [npm('install', ['@types/node@^20.1.0'])]],
    ["npm i '@babel/core@~7.24'", [npm('install', ['@babel/core@~7.24'])]],
    ['npm i "lodash@^4.17.21"', [npm('install', ['lodash@^4.17.21'])]],
    ['npm i lodash@"4.17.21"', [npm('install', ['lodash@4.17.21'])]],
    ["npm i 'react@>=18 <19'", [npm('install', ['react@>=18 <19'])]],
    ['npm i "react@18 || 19"', [npm('install', ['react@18 || 19'])]],
    ['npm i \\@types/node', [npm('install', ['@types/node'])]],
    ['npm i left-pad@npm:right-pad@^1', [npm('install', ['left-pad=right-pad@^1'])]],
    ['npm i str@npm:@scope/string@2', [npm('install', ['str=@scope/string@2'])]],
    ['npm i --save-dev --save-exact typescript', [npm('install', ['typescript'])]],
    ['npm i typescript -D -E', [npm('install', ['typescript'])]],
    ['npm i -DE typescript', [npm('install', ['typescript'])]],
    ['npm install lodash --registry https://registry.npmjs.org/', [npm('install', ['lodash'])]],
    ['npm install lodash --tag next', [npm('install', ['lodash'])]],
    ['npm install --omit dev', [npm('install')]],
    ['npm install --no-audit --no-fund --ignore-scripts lodash', [npm('install', ['lodash'])]],
    ['npm install lodash 2>&1 | tail -5', [npm('install', ['lodash'])]],
    ['npm install lodash > install.log', [npm('install', ['lodash'])]],
    ['npm install lodash # the helpers', [npm('install', ['lodash'])]],
    ['npm install lodash;', [npm('install', ['lodash'])]],
    ['npm install \\\n  lodash \\\n  express', [npm('install', ['lodash', 'express'])]],
  ]);
});

test('parser: workspaces, prefix and global', () => {
  check([
    ['npm i -w api lodash', [npm('install', ['lodash'], { workspaces: ['api'] })]],
    ['npm i --workspace api lodash', [npm('install', ['lodash'], { workspaces: ['api'] })]],
    ['npm i --workspace=api lodash', [npm('install', ['lodash'], { workspaces: ['api'] })]],
    ['npm i -wapi lodash', [npm('install', ['lodash'], { workspaces: ['api'] })]],
    ['npm i -w api -w web lodash', [npm('install', ['lodash'], { workspaces: ['api', 'web'] })]],
    ['npm -w packages/api i lodash', [npm('install', ['lodash'], { workspaces: ['packages/api'] })]],
    ['npm i --workspaces lodash', [npm('install', ['lodash'], { allWorkspaces: true })]],
    ['npm i -ws lodash', [npm('install', ['lodash'], { allWorkspaces: true })]],
    ['npm i --workspaces --include-workspace-root lodash', [npm('install', ['lodash'], { allWorkspaces: true, includeWorkspaceRoot: true })]],
    ['npm i -w "@acme/api" lodash', [npm('install', ['lodash'], { workspaces: ['@acme/api'] })]],
    ['npm i --prefix packages/api lodash', [npm('install', ['lodash'], { dir: '/work/app/packages/api' })]],
    ['npm i --prefix=packages/api lodash', [npm('install', ['lodash'], { dir: '/work/app/packages/api' })]],
    ['npm --prefix ../other install lodash', [npm('install', ['lodash'], { dir: '/work/other' })]],
    ['npm i --prefix /srv/site lodash', [npm('install', ['lodash'], { dir: '/srv/site' })]],
    ['npm i -C packages/api lodash', [npm('install', ['lodash'], { dir: '/work/app/packages/api' })]],
    ['npm i -g typescript', [npm('install', ['typescript'], { dir: null, global: true })]],
    ['npm install --global typescript', [npm('install', ['typescript'], { dir: null, global: true })]],
    ['npm install --location=global typescript', [npm('install', ['typescript'], { dir: null, global: true })]],
    ['npm i -g --prefix ~/.npm-global typescript', [], ['dynamic-option']],
    ['npm i --global=false lodash', [npm('install', ['lodash'])]],
    ['npm i --no-global lodash', [npm('install', ['lodash'])]],
  ]);
});

test('parser: cd and subshells decide the directory a command runs in', () => {
  check([
    ['cd packages/api && npm i lodash', [npm('install', ['lodash'], { dir: '/work/app/packages/api' })]],
    ['cd packages/api; npm i lodash', [npm('install', ['lodash'], { dir: '/work/app/packages/api' })]],
    ['cd /srv/site && npm ci', [npm('ci', [], { dir: '/srv/site' })]],
    ['cd .. && npm ci', [npm('ci', [], { dir: '/work' })]],
    ['cd a && cd b && npm ci', [npm('ci', [], { dir: '/work/app/a/b' })]],
    ['cd a && cd .. && npm ci', [npm('ci')]],
    ['cd -P a && npm ci', [npm('ci', [], { dir: '/work/app/a' })]],
    ['cd -- a && npm ci', [npm('ci', [], { dir: '/work/app/a' })]],
    ['cd "my dir" && npm ci', [npm('ci', [], { dir: '/work/app/my dir' })]],
    ['cd a && npm ci && cd ../b && npm ci', [npm('ci', [], { dir: '/work/app/a' }), npm('ci', [], { dir: '/work/app/b' })]],
    ['(cd a && npm ci) && npm i lodash', [npm('ci', [], { dir: '/work/app/a' }), npm('install', ['lodash'])]],
    ['(cd a; npm ci); npm ci', [npm('ci', [], { dir: '/work/app/a' }), npm('ci')]],
    ['cd a | npm ci', [npm('ci')]],
    ['cd a & npm ci', [npm('ci')]],
    ['cd a || exit 1; npm ci', [npm('ci', [], { dir: '/work/app/a' })]],
    ['cd a && npm ci --prefix ../b', [npm('ci', [], { dir: '/work/app/b' })]],
    ['cd a\nnpm ci', [npm('ci', [], { dir: '/work/app/a' })]],
    ['cd $DIR && npm ci', [], ['unknown-directory']],
    ['cd "$(git rev-parse --show-toplevel)" && npm ci', [], ['unknown-directory']],
    ['cd ~ && npm ci', [], ['unknown-directory']],
    ['cd && npm ci', [], ['unknown-directory']],
    ['cd - && npm ci', [], ['unknown-directory']],
    ['pushd a && npm ci', [npm('ci', [], { dir: '/work/app/a' })]],
    ['pushd a && popd && npm ci', [], ['unknown-directory']],
    // An absolute prefix or a global install needs no working directory.
    ['cd $DIR && npm i --prefix /srv/site lodash', [npm('install', ['lodash'], { dir: '/srv/site' })]],
    ['cd $DIR && npm i -g typescript', [npm('install', ['typescript'], { dir: null, global: true })]],
  ]);
});

test('parser: env prefixes, exports and command wrappers', () => {
  check([
    ['FOO=bar npm i lodash', [npm('install', ['lodash'])]],
    ['CI=true NODE_ENV=production npm ci', [npm('ci')]],
    ['FOO="a b" npm i lodash', [npm('install', ['lodash'])]],
    ['FOO=$(date) npm i lodash', [npm('install', ['lodash'])]],
    ['npm_config_prefix=/srv/site npm i lodash', [npm('install', ['lodash'], { dir: '/srv/site' })]],
    ['NPM_CONFIG_PREFIX=sub npm i lodash', [npm('install', ['lodash'], { dir: '/work/app/sub' })]],
    ['npm_config_global=true npm i typescript', [npm('install', ['typescript'], { dir: null, global: true })]],
    ['npm_config_workspace=api npm i lodash', [npm('install', ['lodash'], { workspaces: ['api'] })]],
    ['npm_config_prefix=/srv/a npm i --prefix /srv/b lodash', [npm('install', ['lodash'], { dir: '/srv/b' })]],
    ['npm_config_prefix=$DIR npm i lodash', [], ['dynamic-option']],
    ['export npm_config_prefix=/srv/site && npm i lodash', [npm('install', ['lodash'], { dir: '/srv/site' })]],
    ['npm_config_prefix=/srv/site; npm i lodash', [npm('install', ['lodash'], { dir: '/srv/site' })]],
    ['export npm_config_prefix=/srv/site; unset npm_config_prefix; npm i lodash', [npm('install', ['lodash'])]],
    ['env npm i lodash', [npm('install', ['lodash'])]],
    ['env FOO=1 BAR=2 npm i lodash', [npm('install', ['lodash'])]],
    ['env -i PATH=$PATH npm i lodash', [npm('install', ['lodash'])]],
    ['env -u HTTP_PROXY npm i lodash', [npm('install', ['lodash'])]],
    ['env -C packages/api npm i lodash', [npm('install', ['lodash'], { dir: '/work/app/packages/api' })]],
    ['sudo npm i -g typescript', [npm('install', ['typescript'], { dir: null, global: true })]],
    ['sudo -u deploy -E npm ci', [npm('ci')]],
    ['time npm ci', [npm('ci')]],
    ['time -p npm ci', [npm('ci')]],
    ['command npm ci', [npm('ci')]],
    ['command -v npm', []],
    ['exec npm ci', [npm('ci')]],
    ['nohup npm ci', [npm('ci')]],
    ['nice -n 10 npm ci', [npm('ci')]],
    ['timeout 120 npm ci', [npm('ci')]],
    ['timeout -s KILL 120 npm ci', [npm('ci')]],
    ['corepack npm ci', [npm('ci')]],
    ['env env env npm ci', [npm('ci')]],
    ['env --weird npm ci', [], ['opaque-command']],
    ['env --weird ls', []],
    ['echo packages | xargs npm i', [npm('install')], ['dynamic-package']],
    ['cat pkgs.txt | xargs -n1 npm install --save-dev', [npm('install')], ['dynamic-package']],
    ['git ls-files | xargs wc -l', []],
  ]);
});

test('parser: npx, npm exec and npm init', () => {
  check([
    ['npx cowsay hello', [npx(['cowsay'])]],
    ['npx cowsay@1.5.0 hello', [npx(['cowsay@1.5.0'])]],
    ['npx -y create-vite@latest my-app --template react', [npx(['create-vite@latest'])]],
    ['npx --yes @angular/cli@17 new demo', [npx(['@angular/cli@17'])]],
    ['npx -p typescript tsc --init', [npx(['typescript'])]],
    ['npx --package=typescript --package=ts-node ts-node x.ts', [npx(['typescript', 'ts-node'])]],
    ['npx -p @scope/tool@2 tool --flag value', [npx(['@scope/tool@2'])]],
    ['npx -c "echo hi"', []],
    ['npx --call "echo hi"', []],
    ['npx -p typescript -c "tsc --version"', [npx(['typescript'])]],
    ['npx --no cowsay hi', []],
    ['npx --no-install cowsay hi', []],
    ['npx -n cowsay hi', []],
    ['npx --yes=false cowsay hi', []],
    ['npx -- cowsay --version', [npx(['cowsay'])]],
    ['npx cowsay --yes', [npx(['cowsay'])]],
    ['npx', []],
    ['npm exec cowsay', [npm('exec', ['cowsay'])]],
    ['npm exec -- cowsay hi', [npm('exec', ['cowsay'])]],
    ['npm exec --package=typescript -- tsc --version', [npm('exec', ['typescript'])]],
    ['npm exec -w api vitest -- --run', [npm('exec', ['vitest'], { workspaces: ['api'] })]],
    ['npm x -y cowsay', [npm('exec', ['cowsay'])]],
    ['npm exec vitest --run src/a.test.ts', [npm('exec', ['vitest'])]],
    ['cd web && npx -y prettier@3 --write .', [npx(['prettier@3'], { dir: '/work/app/web' })]],
    ['npm init vite', [npm('exec', ['create-vite'], { via: 'init' })]],
    ['npm init vite@latest my-app', [npm('exec', ['create-vite@latest'], { via: 'init' })]],
    ['npm create vite@latest', [npm('exec', ['create-vite@latest'], { via: 'init' })]],
    ['npm init @scope', [npm('exec', ['@scope/create'], { via: 'init' })]],
    ['npm init @scope/app', [npm('exec', ['@scope/create-app'], { via: 'init' })]],
    ['npm init @scope/app@2', [npm('exec', ['@scope/create-app@2'], { via: 'init' })]],
    ['npm init -y', []],
    ['npm init', []],
  ]);
});

test('parser: fail closed on dynamic package names and expansions', () => {
  check([
    ['npm i $PKG', [npm('install')], ['dynamic-package']],
    ['npm i "$PKG"', [npm('install')], ['dynamic-package']],
    ['npm i ${PKG}', [npm('install')], ['dynamic-package']],
    ['npm i ${PKG:-lodash}', [npm('install')], ['dynamic-package']],
    ['npm i lodash@$VERSION', [npm('install')], ['dynamic-package']],
    ['npm i "lodash@${V}"', [npm('install')], ['dynamic-package']],
    ['npm i $(cat packages.txt)', [npm('install')], ['dynamic-package']],
    ['npm i "$(cat packages.txt)"', [npm('install')], ['dynamic-package']],
    ['npm i `cat packages.txt`', [npm('install')], ['dynamic-package']],
    ['npm i lodash $EXTRA', [npm('install', ['lodash'])], ['dynamic-package']],
    ['npm i $@', [npm('install')], ['dynamic-package']],
    ['npm i $1', [npm('install')], ['dynamic-package']],
    ['npm i @types/*', [npm('install')], ['dynamic-package']],
    ['npm i lodash?', [npm('install')], ['dynamic-package']],
    ['npm i {lodash,express}', [npm('install')], ['dynamic-package']],
    ['npm i lodash@{4,5}', [npm('install')], ['dynamic-package']],
    ['npm i ~user/pkg', [npm('install')], ['dynamic-package']],
    ["npm i $'lodash'", [npm('install')], ['dynamic-package']],
    ['npm i <(echo lodash)', [npm('install')], ['dynamic-package']],
    ['npm i -D $PKG lodash', [npm('install', ['lodash'])], ['dynamic-package']],
    ['npx $TOOL', [], ['dynamic-package']],
    ['npx -p $PKG tsc', [], ['dynamic-package']],
    ['npx --package=$PKG tsc', [], ['dynamic-package']],
    ['npm exec $TOOL', [], ['dynamic-package']],
    ['npm init $KIT', [], ['dynamic-package']],
    ['npm i $FLAGS', [npm('install')], ['dynamic-package']],
    ['npm $CMD lodash', [], ['dynamic-command']],
    ['npm audit $SUB', [], ['dynamic-command']],
    ['npm i -w $WS lodash', [], ['dynamic-option']],
    ['npm i --workspace="$WS" lodash', [], ['dynamic-option']],
    ['npm i --prefix "$DIR" lodash', [], ['dynamic-option']],
    ['npm i --registry $REG lodash', [], ['dynamic-option']],
    ['npm i --global=$G lodash', [], ['dynamic-option']],
    ['for p in lodash express; do npm i $p; done', [npm('install')], ['dynamic-package']],
    ['while read p; do npm i "$p"; done < packages.txt', [npm('install')], ['dynamic-package']],
    ['if [ -f package.json ]; then npm ci; fi', [npm('ci')]],
    ['for d in a b; do (cd $d && npm ci); done', [], ['unknown-directory']],
  ]);
});

test('parser: dynamic values that do not decide what is installed are fine', () => {
  check([
    ['npm install --loglevel $LEVEL lodash', [npm('install', ['lodash'])]],
    ['npm ci --cache "$HOME/.npm"', [npm('ci')]],
    ['npm test -- $FILE', []],
    ['npm run $SCRIPT', []],
    ['npm ci && echo $HOME && ls $(pwd)', [npm('ci')]],
    ['FOO=$BAR npm ci', [npm('ci')]],
    ['echo $(date) > "$LOG" && npm ci', [npm('ci')]],
    ['npm ci 2> "$ERR_LOG"', [npm('ci')]],
    ['git diff $(git merge-base HEAD main) -- package.json', []],
    ['eval "$(ssh-agent -s)"', []],
    ['bash -c "$CMD"', []],
    ['$EDITOR notes.md', []],
    ['"$HOME/bin/tool" install', []],
  ]);
});

test('parser: command substitutions, backticks and subshells are parsed as commands of their own', () => {
  check([
    ['echo $(npm i lodash)', [npm('install', ['lodash'])]],
    ['echo "$(npm i lodash)"', [npm('install', ['lodash'])]],
    ['echo `npm i lodash`', [npm('install', ['lodash'])]],
    ['x=$(npm i lodash)', [npm('install', ['lodash'])]],
    ['echo $(echo $(npm i lodash))', [npm('install', ['lodash'])]],
    ['echo $(cd a && npm ci) && npm ci', [npm('ci', [], { dir: '/work/app/a' }), npm('ci')]],
    ['echo $(npm i $PKG)', [npm('install')], ['dynamic-package']],
    ['cat <(npm i lodash)', [npm('install', ['lodash'])]],
    ['echo ${X:-$(npm i lodash)}', [npm('install', ['lodash'])]],
    ['echo "${X:-$(npm i lodash)}"', [npm('install', ['lodash'])]],
    ['npm i $(npm view lodash version)', [npm('install')], ['dynamic-package']],
    ['echo $((1 + 2))', []],
    ['echo $(git rev-parse HEAD) && npm ci', [npm('ci')]],
    ["echo '$(npm i lodash)'", []],
    ['( npm ci )', [npm('ci')]],
    ['{ npm ci; }', [npm('ci')]],
    ['! npm ci', [npm('ci')]],
    ['case $x in a) npm ci ;; esac', [npm('ci')]],
  ]);
});

test('parser: shell strings, eval, redirections and here-documents', () => {
  check([
    ['bash -c "npm i lodash"', [npm('install', ['lodash'])]],
    ["sh -c 'cd a && npm ci'", [npm('ci', [], { dir: '/work/app/a' })]],
    ["bash -lc 'npm ci'", [npm('ci')]],
    ["zsh -c 'npm ci' arg0", [npm('ci')]],
    ["bash --norc -c 'npm ci'", [npm('ci')]],
    ["bash -o pipefail -c 'npm ci'", [npm('ci')]],
    ['bash -c "npm i $PKG"', [npm('install')], ['dynamic-package']],
    ['bash -c "echo hi"', []],
    ['bash script.sh', []],
    ["bash -c 'bash -c \"npm ci\"'", [npm('ci')]],
    ['eval npm i lodash', [npm('install', ['lodash'])]],
    ['eval "npm i lodash"', [npm('install', ['lodash'])]],
    ['eval "cd a"; npm ci', [npm('ci', [], { dir: '/work/app/a' })]],
    ['PKG=lodash; eval "npm i $PKG"', [npm('install')], ['dynamic-package']],
    ['CMD="npm i lodash"; eval "$CMD"', [], ['dynamic-command']],
    ['CMD="npm i lodash"; bash -c "$CMD"', [], ['dynamic-command']],
    ['npm ci >/dev/null 2>&1', [npm('ci')]],
    ['npm ci &>/dev/null', [npm('ci')]],
    ['npm ci < /dev/null', [npm('ci')]],
    ['2>/dev/null npm ci', [npm('ci')]],
    ['npm i lodash >> log.txt 2>&1 &', [npm('install', ['lodash'])]],
    ['cat <<EOF\nnpm install evil\nEOF\nnpm ci', [npm('ci')]],
    ["cat <<'EOF'\nnpm install $(evil)\nEOF\nnpm ci", [npm('ci')]],
    ['cat <<-EOF\n\tnpm install evil\n\tEOF\nnpm ci', [npm('ci')]],
    ['cat <<EOF\n$(npm i lodash)\nEOF', [npm('install', ['lodash'])]],
    ["cat <<EOF\ndon't parse this\nEOF\nnpm ci", [npm('ci')]],
    ['cat <<EOF | tee out\nhello\nEOF\nnpm ci', [npm('ci')]],
    ['cat <<< "npm i evil"', []],
  ]);
});

test('parser: unsupported sources and malformed specifications fail closed', () => {
  check([
    ['npm i git+https://github.com/a/b.git', [npm('install')], ['unsupported-source']],
    ['npm i git@github.com:a/b.git', [npm('install')], ['unsupported-source']],
    ['npm i github:a/b', [npm('install')], ['unsupported-source']],
    ['npm i a/b', [npm('install')], ['unsupported-source']],
    ['npm i a/b#semver:^1', [npm('install')], ['unsupported-source']],
    ['npm i https://example.com/pkg.tgz', [npm('install')], ['unsupported-source']],
    ['npm i ./local-pkg', [npm('install')], ['unsupported-source']],
    ['npm i ../sibling', [npm('install')], ['unsupported-source']],
    ['npm i /abs/path/pkg', [npm('install')], ['unsupported-source']],
    ['npm i .', [npm('install')], ['unsupported-source']],
    ['npm i file:../pkg', [npm('install')], ['unsupported-source']],
    ['npm i pkg.tgz', [npm('install')], ['unsupported-source']],
    ['npm i foo@github:a/b', [npm('install')], ['unsupported-source']],
    ['npm i foo@file:../foo', [npm('install')], ['unsupported-source']],
    ['npm i foo@https://example.com/foo.tgz', [npm('install')], ['unsupported-source']],
    ['npm i foo@npm:github:a/b', [npm('install')], ['unsupported-source']],
    ['npm i lodash ./local', [npm('install', ['lodash'])], ['unsupported-source']],
    ['npx github:a/b', [], ['unsupported-source']],
    ['npx ./script.js', [], ['unsupported-source']],
    ['npx -p git+https://github.com/a/b.git tool', [], ['unsupported-source']],
    ['npm init ./template', [], ['unsupported-source']],
    ['npm i "bad name"', [npm('install')], ['invalid-package']],
    ['npm i Lodash!', [npm('install')], ['invalid-package']],
    ['npm i @scope', [npm('install')], ['invalid-package']],
    ['npm i {}', [npm('install')], ['invalid-package']],
  ]);
});

test('parser: an unknown option fails closed only when it could swallow a package', () => {
  check([
    ['npm i --frobnicate lodash', [npm('install', ['lodash'])], ['ambiguous-option']],
    ['npm i lodash --frobnicate', [npm('install', ['lodash'])]],
    ['npm i --frobnicate --save-dev lodash', [npm('install', ['lodash'])]],
    ['npm i --frobnicate=yes lodash', [npm('install', ['lodash'])]],
    ['npm i -Z lodash', [npm('install', ['lodash'])], ['ambiguous-option']],
    ['npm i -DZ lodash', [npm('install', ['lodash'])], ['ambiguous-option']],
  ]);
});

test('parser: unparseable input fails closed', () => {
  check([
    ['npm i "lodash', [], ['unparseable']],
    ["npm i 'lodash", [], ['unparseable']],
    ['echo $(npm i lodash', [], ['unparseable']],
    ['echo `npm i lodash', [], ['unparseable']],
    ['echo ${X', [], ['unparseable']],
    ['npm ci && echo "oops', [], ['unparseable']],
    ['echo $(echo $(echo $(echo $(echo $(echo $(echo $(echo $(echo $(npm i x)))))))))', [], ['unparseable']],
  ]);
});

test('parser: the input is validated and never touched', () => {
  assert.throws(() => parseCommandLine(42, { cwd: CWD }), TypeError);
  assert.throws(() => parseCommandLine('npm ci', { cwd: 'relative/dir' }), TypeError);
  assert.throws(() => parseCommandLine('npm ci'), TypeError);
  const before = process.cwd();
  parseCommandLine('cd /nonexistent && npm i $(touch /tmp/guardian-parser-must-not-run)', { cwd: CWD });
  assert.equal(process.cwd(), before);
  assert.equal(parseCommandLine('npm ci', { cwd: '/work/app/../app/' }).actions[0].dir, '/work/app');
});

test('parser: a result lists a repeated command once and keeps the raw text', () => {
  const r = parseCommandLine('bash -c "$(npm i lodash)"', { cwd: CWD });
  assert.equal(r.actions.length, 1);
  assert.equal(r.actions[0].raw, 'npm i lodash');
  const two = parseCommandLine('npm i a && npm i a', { cwd: CWD });
  assert.equal(two.actions.length, 1);
  const w = parseCommandLine('npm i $PKG', { cwd: CWD });
  assert.deepEqual(w.unjudgeable.map((u) => u.text), ['npm i $PKG']);
  assert.match(w.unjudgeable[0].reason, /\$PKG.*expanded by the shell/);
});

test('package specs: registry packages parse and everything else says why not', () => {
  const ok = (spec, rest) => assert.deepEqual(parsePackageSpec(spec), { ok: true, spec, alias: null, range: null, ...rest }, spec);
  ok('lodash', { name: 'lodash' });
  ok('lodash@^4', { name: 'lodash', range: '^4' });
  ok('@types/node@20', { name: '@types/node', range: '20' });
  ok('@a/b', { name: '@a/b' });
  ok('a.b_c-d~e', { name: 'a.b_c-d~e' });
  assert.deepEqual(parsePackageSpec('x@npm:@a/b@1'), { ok: true, spec: 'x@npm:@a/b@1', name: '@a/b', range: '1', alias: 'x' });
  for (const [spec, kind] of [['./x', 'unsupported-source'], ['github:a/b', 'unsupported-source'], ['a/b', 'unsupported-source'], ['x@git+ssh://h/r.git', 'unsupported-source'], ['', 'invalid-package'], ['UP PER', 'invalid-package'], ['.hidden', 'invalid-package'], ['_x', 'invalid-package']]) {
    const r = parsePackageSpec(spec);
    assert.equal(r.ok, false, spec);
    assert.equal(r.kind, kind, spec);
    assert.ok(r.reason.length > 10);
  }
});

test('npm command words: aliases and abbreviations resolve as npm resolves them', () => {
  for (const [word, command] of [['install', 'install'], ['i', 'install'], ['ISNTALL', 'install'], ['add', 'install'], ['it', 'install-test'], ['cit', 'install-ci-test'], ['ic', 'ci'], ['up', 'update'], ['upd', 'update'], ['x', 'exec'], ['create', 'init'], ['innit', 'init'], ['t', 'test'], ['rm', 'uninstall'], ['un', 'uninstall'], ['expl', null], ['u', null], ['ad', null], ['zzz', null], ['', null]]) {
    assert.equal(canonicalNpmCommand(word), command, word);
  }
});
