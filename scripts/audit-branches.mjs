#!/usr/bin/env node
import { spawnSync } from 'node:child_process';

const args = new Set(process.argv.slice(2));
const shouldDelete = args.has('--delete');
const includeRemotes = !args.has('--local-only');
const mainRef = valueForArg('--main') ?? 'main';
const deleteRemotes = valueForArg('--delete-remotes')?.split(',').filter(Boolean) ?? ['origin'];

const protectedRefNames = new Set([
  mainRef,
  `origin/${mainRef}`,
  `mac-mini/${mainRef}`,
  'HEAD',
  'origin/HEAD',
  'mac-mini/HEAD'
]);

const mainCommit = git(['rev-parse', '--verify', mainRef]).trim();
const mainTrees = new Set(
  git(['rev-list', mainRef])
    .trim()
    .split('\n')
    .filter(Boolean)
    .map((commit) => git(['show', '-s', '--format=%T', commit]).trim())
);
const refs = git([
  'for-each-ref',
  '--format=%(refname)%09%(refname:short)%09%(objectname)',
  'refs/heads',
  ...(includeRemotes ? ['refs/remotes'] : [])
])
  .trim()
  .split('\n')
  .filter(Boolean)
  .map(parseRefLine)
  .filter((ref) => !protectedRefNames.has(ref.shortName))
  .filter((ref) => !ref.shortName.endsWith('/HEAD'));

const results = refs.map(classifyRef);
const deletable = results.filter((result) => result.deleteSafe);
const unique = results.filter((result) => !result.deleteSafe);

printResults('Delete-safe branches', deletable);
printResults('Branches with unique work', unique);

if (!shouldDelete) {
  console.log('\nDry run only. Re-run with --delete to prune delete-safe local branches and delete-safe origin branches.');
  process.exit(unique.length > 0 ? 2 : 0);
}

for (const result of deletable) {
  deleteRef(result.ref);
}

function classifyRef(ref) {
  const tree = git(['show', '-s', '--format=%T', ref.fullName]).trim();
  if (isAncestor(ref.fullName, mainCommit)) {
    return {
      ref,
      deleteSafe: true,
      reason: 'merged into main'
    };
  }

  if (mainTrees.has(tree)) {
    return {
      ref,
      deleteSafe: true,
      reason: 'tree matches a commit already reachable from main'
    };
  }

  const uniquePatchCommits = git(['cherry', mainRef, ref.fullName])
    .trim()
    .split('\n')
    .filter(Boolean)
    .filter((line) => line.startsWith('+ '));
  if (uniquePatchCommits.length === 0) {
    return {
      ref,
      deleteSafe: true,
      reason: 'all non-main commits are patch-equivalent to main'
    };
  }

  return {
    ref,
    deleteSafe: false,
    reason: `${uniquePatchCommits.length} commit(s) with unique patches`
  };
}

function deleteRef(ref) {
  if (ref.fullName.startsWith('refs/heads/')) {
    runGit(['branch', '-D', ref.shortName]);
    console.log(`deleted local ${ref.shortName}`);
    return;
  }

  if (!ref.fullName.startsWith('refs/remotes/')) {
    console.log(`skipped ${ref.shortName}: unsupported ref namespace`);
    return;
  }

  const [remote, ...branchParts] = ref.shortName.split('/');
  const branch = branchParts.join('/');
  if (!deleteRemotes.includes(remote)) {
    console.log(`skipped ${ref.shortName}: remote ${remote} is not in --delete-remotes`);
    return;
  }

  runGit(['push', remote, '--delete', branch]);
  console.log(`deleted remote ${ref.shortName}`);
}

function parseRefLine(line) {
  const [fullName, shortName, commit] = line.split('\t');
  return {
    fullName,
    shortName,
    commit
  };
}

function isAncestor(ancestor, descendant) {
  const result = spawnSync('git', ['merge-base', '--is-ancestor', ancestor, descendant], {
    stdio: 'ignore'
  });
  return result.status === 0;
}

function printResults(title, branchResults) {
  console.log(`\n${title} (${branchResults.length})`);
  if (branchResults.length === 0) {
    console.log('  none');
    return;
  }

  for (const result of branchResults.sort((left, right) => left.ref.shortName.localeCompare(right.ref.shortName))) {
    console.log(`  ${result.ref.shortName.padEnd(42)} ${result.ref.commit.slice(0, 8)}  ${result.reason}`);
  }
}

function valueForArg(name) {
  const prefix = `${name}=`;
  const match = process.argv.slice(2).find((arg) => arg.startsWith(prefix));
  return match ? match.slice(prefix.length) : null;
}

function git(args) {
  const result = spawnSync('git', args, {
    encoding: 'utf8'
  });
  if (result.status !== 0) {
    throw new Error(`git ${args.join(' ')} failed: ${result.stderr.trim()}`);
  }
  return result.stdout;
}

function runGit(args) {
  const result = spawnSync('git', args, {
    encoding: 'utf8',
    stdio: 'pipe'
  });
  if (result.status !== 0) {
    throw new Error(`git ${args.join(' ')} failed: ${result.stderr.trim()}`);
  }
}
