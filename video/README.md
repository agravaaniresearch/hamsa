# The 0.6 walkthrough video

Source of `docs/hamsa-0.6.mp4`, a Remotion composition. To render it again:

```sh
npm i remotion@4 @remotion/cli@4 @remotion/transitions@4 react@18 react-dom@18
# put the fonts from extension/fonts and four screenshots (front.png, thread.png, thread-dark.png, front-wide.png) in public/
npx remotion render index.jsx Hamsa out/hamsa.mp4
```

Screens use synthetic interests and saved HN pages, for illustration only.
