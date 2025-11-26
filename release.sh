#!/bin/bash

# Exit immediately if a command exits with a non-zero status
set -e

# Ensure we are in the project root
cd "$(dirname "$0")"

echo "🚀 Starting release process..."

# 1. Run tests
echo "🧪 Running tests..."
npm test

# 2. Build the project
echo "🏗️  Building project..."
npm run build

# 3. Determine version bump
VERSION_TYPE=$1

if [ -z "$VERSION_TYPE" ]; then
  echo "Select version bump type:"
  select v in "patch" "minor" "major"; do
    case $v in
      patch|minor|major ) VERSION_TYPE=$v; break;;
      * ) echo "Invalid selection";;
    esac
  done
fi

# 4. Bump version (this updates package.json, creates a git commit, and a git tag)
# We use --no-git-tag-version first to check if it works, but actually npm version handles it well.
# Let's just run npm version.
echo "📈 Bumping version ($VERSION_TYPE)..."
npm version $VERSION_TYPE

# 5. Publish to NPM
echo "📦 Publishing to NPM..."
# --access public is important for scoped packages like @cajax/axios-parallel-limit
npm publish --access public

# 6. Push to Git
echo "pushing to Git..."
BRANCH=$(git rev-parse --abbrev-ref HEAD)
git push origin $BRANCH --follow-tags

echo "✅ Release complete!"
