`mediapipe-portrait.jpg` is the unmodified portrait image published with Google's
MediaPipe examples: https://storage.googleapis.com/mediapipe-assets/portrait.jpg

The portrait browser test decodes this public example and draws it twice onto a
canvas to exercise real two-face detection. Test uploads stay on localhost;
neither the fixture nor the user's photos are sent to an image service.

`mediapipe-pose.jpg` is the unmodified standing-pose image published with
Google's MediaPipe examples: https://storage.googleapis.com/mediapipe-assets/pose.jpg
The portrait-studio test draws it twice to exercise real, independent body
localization and local shape controls. Photos and model processing stay local.
