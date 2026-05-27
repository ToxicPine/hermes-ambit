#!/usr/bin/env bash
set -euo pipefail

die() {
  echo "wghc: $*" >&2
  exit 1
}

usage() {
  cat <<'USAGE'
Usage: wghc [options] REPO [WORKTREE]

Create or reuse a shared bare GitHub clone and add a git worktree from it.

Examples:
  wghc cli/cli
  wghc cli/cli feature-x -b feature-x
  wghc https://github.com/cli/cli.git cli-main --filter=blob:none

Options:
  -r, --root DIR                  Root for repos (default: $WGH_ROOT or ~/with-runners)
      --repo-path PATH            Path under root for this repo (default: gh/OWNER/REPO)
      --bare-dir DIR              Bare repo path (default: ROOT/REPO_PATH/.bare)
      --base BRANCH               Base branch (default: origin's default branch)
  -b, --branch BRANCH             Create worktree branch with git worktree add -b
  -B, --reset-branch BRANCH       Create/reset worktree branch with git worktree add -B
      --detach                    Add a detached worktree
      --orphan                    Create an orphan worktree
  -f, --force                     Forward to git worktree add
      --checkout                  Forward to git worktree add
      --no-checkout               Forward to git worktree add
      --guess-remote              Forward to git worktree add
      --no-guess-remote           Forward to git worktree add
      --lock                      Forward to git worktree add
      --no-lock                   Forward to git worktree add
      --reason TEXT               Forward to git worktree add
      --track                     Forward to git worktree add
      --no-track                  Forward to git worktree add
      --relative-paths            Forward to git worktree add
      --no-relative-paths         Forward to git worktree add
  -u, --upstream-remote-name NAME Forward to gh repo clone
      --depth N                   Forward to clone/fetch
      --filter SPEC               Forward to clone/fetch
      --shallow-since DATE        Forward to clone/fetch
      --shallow-exclude REV       Forward to clone/fetch
      --single-branch             Forward to clone
      --no-single-branch          Forward to clone
      --upload-pack PATH          Forward to clone/fetch
      --server-option OPTION      Forward to clone/fetch
      --tags                      Forward to fetch
      --no-tags                   Forward to clone/fetch
      --prune                     Forward to fetch
      --no-prune                  Forward to fetch
      --prune-tags                Forward to fetch
      --no-prune-tags             Forward to fetch
      --jobs N                    Forward to clone/fetch
  -j N                            Forward to clone/fetch
  -4, --ipv4                      Forward to clone/fetch
  -6, --ipv6                      Forward to clone/fetch
      --clone-arg ARG             Extra raw arg for git clone via gh repo clone -- ...
      --fetch-arg ARG             Extra raw arg for git fetch
      --worktree-arg ARG          Extra raw arg for git worktree add
  -h, --help                      Show this help

Environment:
  WGH_ROOT                        Default root directory
USAGE
}

sanitize_path_segment() {
  local segment="$1"

  segment="${segment//[^A-Za-z0-9._-]/-}"
  while [[ "$segment" == -* ]]; do
    segment="${segment#-}"
  done
  while [[ "$segment" == *- ]]; do
    segment="${segment%-}"
  done
  if [[ -z "$segment" || "$segment" == "." || "$segment" == ".." ]]; then
    segment="unknown"
  fi
  printf '%s\n' "$segment"
}

repo_path_from_repo() {
  local repo="$1"
  local path owner name

  repo="${repo%/}"
  repo="${repo%%\?*}"
  repo="${repo%%#*}"

  case "$repo" in
    git@github.com:*)
      path="${repo#git@github.com:}"
      ;;
    ssh://git@github.com/*)
      path="${repo#ssh://git@github.com/}"
      ;;
    https://github.com/*)
      path="${repo#https://github.com/}"
      ;;
    http://github.com/*)
      path="${repo#http://github.com/}"
      ;;
    git://github.com/*)
      path="${repo#git://github.com/}"
      ;;
    github.com/*)
      path="${repo#github.com/}"
      ;;
    github.com:*)
      path="${repo#github.com:}"
      ;;
    */*)
      path="$repo"
      ;;
    *)
      path=""
      ;;
  esac

  if [[ -n "$path" && "$path" == */* ]]; then
    owner="${path%%/*}"
    name="${path#*/}"
    name="${name%%/*}"
    name="${name%.git}"
    printf 'gh/%s/%s\n' "$(sanitize_path_segment "$owner")" "$(sanitize_path_segment "$name")"
    return 0
  fi

  name="${repo##*/}"
  name="${name%.git}"
  printf 'git/%s\n' "$(sanitize_path_segment "$name")"
}

default_worktree_name() {
  local repo="$1"
  local name

  name="${repo%/}"
  name="${name%%\?*}"
  name="${name%%#*}"
  name="${name##*/}"
  name="${name%.git}"
  sanitize_path_segment "$name"
}

need_value() {
  local option="$1"
  local count="$2"

  [[ "$count" -ge 2 ]] || die "$option requires a value"
}

ROOT="${WGH_ROOT:-"$HOME/with-runners"}"
REPO_PATH=""
BARE_DIR=""
BASE_BRANCH="auto"
BRANCH_MODE=()
BRANCH_KIND=""
WORKTREE_FLAGS=()
GH_CLONE_FLAGS=()
CLONE_FLAGS=()
FETCH_FLAGS=(--prune --quiet)
REPO=""
WORKTREE_NAME=""

while [[ $# -gt 0 ]]; do
  case "$1" in
    -h|--help)
      usage
      exit 0
      ;;
    -r|--root)
      need_value "$1" "$#"
      ROOT="$2"
      shift 2
      ;;
    --root=*)
      ROOT="${1#*=}"
      shift
      ;;
    --repo-path)
      need_value "$1" "$#"
      REPO_PATH="$2"
      shift 2
      ;;
    --repo-path=*)
      REPO_PATH="${1#*=}"
      shift
      ;;
    --bare-dir)
      need_value "$1" "$#"
      BARE_DIR="$2"
      shift 2
      ;;
    --bare-dir=*)
      BARE_DIR="${1#*=}"
      shift
      ;;
    --base)
      need_value "$1" "$#"
      BASE_BRANCH="$2"
      shift 2
      ;;
    --base=*)
      BASE_BRANCH="${1#*=}"
      shift
      ;;
    -b|--branch)
      need_value "$1" "$#"
      [[ "${#BRANCH_MODE[@]}" -eq 0 ]] || die "only one of --branch, --reset-branch, --detach, or --orphan may be used"
      BRANCH_MODE=(-b "$2")
      BRANCH_KIND="branch"
      shift 2
      ;;
    --branch=*)
      [[ "${#BRANCH_MODE[@]}" -eq 0 ]] || die "only one of --branch, --reset-branch, --detach, or --orphan may be used"
      BRANCH_MODE=(-b "${1#*=}")
      BRANCH_KIND="branch"
      shift
      ;;
    -B|--reset-branch)
      need_value "$1" "$#"
      [[ "${#BRANCH_MODE[@]}" -eq 0 ]] || die "only one of --branch, --reset-branch, --detach, or --orphan may be used"
      BRANCH_MODE=(-B "$2")
      BRANCH_KIND="branch"
      shift 2
      ;;
    --reset-branch=*)
      [[ "${#BRANCH_MODE[@]}" -eq 0 ]] || die "only one of --branch, --reset-branch, --detach, or --orphan may be used"
      BRANCH_MODE=(-B "${1#*=}")
      BRANCH_KIND="branch"
      shift
      ;;
    -d|--detach)
      [[ "${#BRANCH_MODE[@]}" -eq 0 ]] || die "only one of --branch, --reset-branch, --detach, or --orphan may be used"
      BRANCH_MODE=(--detach)
      BRANCH_KIND="detach"
      shift
      ;;
    --orphan)
      [[ "${#BRANCH_MODE[@]}" -eq 0 ]] || die "only one of --branch, --reset-branch, --detach, or --orphan may be used"
      BRANCH_MODE=(--orphan)
      BRANCH_KIND="orphan"
      shift
      ;;
    -f|--force|--checkout|--no-checkout|--guess-remote|--no-guess-remote|--lock|--no-lock|--track|--no-track|--relative-paths|--no-relative-paths)
      WORKTREE_FLAGS+=("$1")
      shift
      ;;
    --reason)
      need_value "$1" "$#"
      WORKTREE_FLAGS+=("$1" "$2")
      shift 2
      ;;
    --reason=*)
      WORKTREE_FLAGS+=("--reason" "${1#*=}")
      shift
      ;;
    -u|--upstream-remote-name)
      need_value "$1" "$#"
      GH_CLONE_FLAGS+=(--upstream-remote-name "$2")
      shift 2
      ;;
    --upstream-remote-name=*)
      GH_CLONE_FLAGS+=(--upstream-remote-name "${1#*=}")
      shift
      ;;
    --depth|--filter|--shallow-since|--shallow-exclude|--upload-pack|--server-option|--jobs)
      need_value "$1" "$#"
      CLONE_FLAGS+=("$1" "$2")
      FETCH_FLAGS+=("$1" "$2")
      shift 2
      ;;
    --depth=*|--filter=*|--shallow-since=*|--shallow-exclude=*|--upload-pack=*|--server-option=*|--jobs=*)
      CLONE_FLAGS+=("$1")
      FETCH_FLAGS+=("$1")
      shift
      ;;
    -j)
      need_value "$1" "$#"
      CLONE_FLAGS+=("$1" "$2")
      FETCH_FLAGS+=("$1" "$2")
      shift 2
      ;;
    -4|-6|--ipv4|--ipv6)
      CLONE_FLAGS+=("$1")
      FETCH_FLAGS+=("$1")
      shift
      ;;
    --single-branch|--no-single-branch)
      CLONE_FLAGS+=("$1")
      shift
      ;;
    --tags)
      FETCH_FLAGS+=("$1")
      shift
      ;;
    --no-tags)
      CLONE_FLAGS+=("$1")
      FETCH_FLAGS+=("$1")
      shift
      ;;
    --prune|--no-prune|--prune-tags|--no-prune-tags)
      next_fetch_flags=()
      for fetch_flag in "${FETCH_FLAGS[@]}"; do
        case "$1:$fetch_flag" in
          --prune:*--prune|--no-prune:*--prune)
            continue
            ;;
          --prune-tags:*--prune-tags|--no-prune-tags:*--prune-tags)
            continue
            ;;
        esac
        next_fetch_flags+=("$fetch_flag")
      done
      FETCH_FLAGS=("${next_fetch_flags[@]}")
      FETCH_FLAGS+=("$1")
      shift
      ;;
    --clone-arg)
      need_value "$1" "$#"
      CLONE_FLAGS+=("$2")
      shift 2
      ;;
    --clone-arg=*)
      CLONE_FLAGS+=("${1#*=}")
      shift
      ;;
    --fetch-arg)
      need_value "$1" "$#"
      FETCH_FLAGS+=("$2")
      shift 2
      ;;
    --fetch-arg=*)
      FETCH_FLAGS+=("${1#*=}")
      shift
      ;;
    --worktree-arg)
      need_value "$1" "$#"
      WORKTREE_FLAGS+=("$2")
      shift 2
      ;;
    --worktree-arg=*)
      WORKTREE_FLAGS+=("${1#*=}")
      shift
      ;;
    --)
      shift
      [[ $# -eq 0 ]] || die "unexpected arguments after --: $*"
      break
      ;;
    -*)
      die "unknown option: $1"
      ;;
    *)
      if [[ -z "$REPO" ]]; then
        REPO="$1"
      elif [[ -z "$WORKTREE_NAME" ]]; then
        WORKTREE_NAME="$1"
      else
        die "unexpected argument: $1"
      fi
      shift
      ;;
  esac
done

[[ -n "$REPO" ]] || die "missing REPO"

if ! command -v gh >/dev/null 2>&1; then
  die "gh required"
fi

if ! command -v git >/dev/null 2>&1; then
  die "git required"
fi

if [[ -z "$REPO_PATH" ]]; then
  REPO_PATH="$(repo_path_from_repo "$REPO")"
fi

if [[ -z "$BARE_DIR" ]]; then
  BARE_DIR="${ROOT%/}/${REPO_PATH}/.bare"
fi

if [[ -z "$WORKTREE_NAME" ]]; then
  WORKTREE_NAME="$(default_worktree_name "$REPO")"
fi

WORKTREE_DIR="${ROOT%/}/${REPO_PATH}/${WORKTREE_NAME}"

mkdir -p "$(dirname "$BARE_DIR")"

if [[ ! -d "$BARE_DIR" ]]; then
  gh repo clone "$REPO" "$BARE_DIR" "${GH_CLONE_FLAGS[@]}" -- --bare "${CLONE_FLAGS[@]}"
else
  if [[ "$(git --git-dir="$BARE_DIR" rev-parse --is-bare-repository 2>/dev/null || true)" != "true" ]]; then
    die "$BARE_DIR exists but is not a bare git repository"
  fi
fi

if ! git --git-dir="$BARE_DIR" remote get-url origin >/dev/null 2>&1; then
  die "$BARE_DIR has no origin remote"
fi

git --git-dir="$BARE_DIR" config --replace-all remote.origin.fetch "+refs/heads/*:refs/remotes/origin/*"
git --git-dir="$BARE_DIR" fetch "${FETCH_FLAGS[@]}" origin
git --git-dir="$BARE_DIR" remote set-head origin -a >/dev/null 2>&1 || true

if [[ "$BASE_BRANCH" == "auto" ]]; then
  origin_head="$(git --git-dir="$BARE_DIR" symbolic-ref -q --short refs/remotes/origin/HEAD 2>/dev/null || true)"
  if [[ -n "$origin_head" ]]; then
    BASE_BRANCH="${origin_head#origin/}"
  elif git --git-dir="$BARE_DIR" show-ref --verify --quiet refs/remotes/origin/main; then
    BASE_BRANCH="main"
  elif git --git-dir="$BARE_DIR" show-ref --verify --quiet refs/remotes/origin/master; then
    BASE_BRANCH="master"
  else
    die "could not determine default branch; set --base"
  fi
fi

if [[ -e "$WORKTREE_DIR" ]]; then
  die "$WORKTREE_DIR already exists"
fi

mkdir -p "$(dirname "$WORKTREE_DIR")"

if [[ "$BRANCH_KIND" == "orphan" ]]; then
  git --git-dir="$BARE_DIR" worktree add --quiet "${WORKTREE_FLAGS[@]}" "${BRANCH_MODE[@]}" "$WORKTREE_DIR"
else
  git --git-dir="$BARE_DIR" worktree add --quiet "${WORKTREE_FLAGS[@]}" "${BRANCH_MODE[@]}" "$WORKTREE_DIR" "origin/$BASE_BRANCH"
fi
