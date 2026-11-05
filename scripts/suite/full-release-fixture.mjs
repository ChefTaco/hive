// Disposable developer full-suite proof: pushes exact local candidate images to the
// caller's private ephemeral registry, then applies the reviewed full-profile contracts
// from release-contracts.mjs, the same ones a published release uses.
import assert from 'node:assert/strict';
import { addFullComponents } from './release-contracts.mjs';
export function extendFullFixture({ manifest, registry, id, tags, docker, user }) {
  const push = (product, local) => {
    const tag = registry + '/' + id + '/' + product + ':candidate'; tags.push(tag);
    docker('tag', local, tag); docker('push', tag);
    const image = JSON.parse(docker('image', 'inspect', tag, '--format', '{{json .RepoDigests}}')).find(value => value.startsWith(registry + '/' + id + '/' + product + '@sha256:'));
    assert(image); return image;
  };
  const images = Object.fromEntries([['magnus', 'magnus-server:candidate'], ['cindertrace', 'cindertrace:candidate'], ['chattermost', 'chattermost:candidate'], ['chat-migrator', 'chattermost-migrator:candidate'], ['emberfold', 'emberfold:candidate'], ['magnus-gateway', 'magnus-gateway:candidate']].map(([product, local]) => [product, push(product, local)]));
  addFullComponents(manifest, { images, user });
}
