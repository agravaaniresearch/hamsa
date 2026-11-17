import React from "react";
import { Composition, registerRoot } from "remotion";
import { Video, DURATION } from "./Video.jsx";
const Root = () => <Composition id="Hamsa" component={Video} durationInFrames={DURATION} fps={30} width={1920} height={1080} />;
registerRoot(Root);
