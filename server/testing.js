// CORRECT: import from the npm package name, not from an internal repo path.
// '../dist/src/index' is the path used inside yt-converter's OWN test folder —
// it only works when running tests from within the yt-converter source repository.
// As a consumer project, always import from the package name:
import { Audio } from 'yt-converter';

const link = 'https://www.youtube.com/watch?v=QI5idh3Uwh4&list=RDQI5idh3Uwh4&start_radio=1';

async function test(url) {
  const data = await Audio({
    url,
    onDownloading: (d) => console.log(d),
  });

  console.log(data.message);
}

test(link);