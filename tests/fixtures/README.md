`mediapipe-portrait.jpg` is the unmodified portrait image published with Google's
MediaPipe examples: https://storage.googleapis.com/mediapipe-assets/portrait.jpg

The portrait browser test decodes this public example and draws it twice onto a
canvas to exercise real two-face detection. Test uploads stay on localhost;
neither the fixture nor the user's photos are sent to an image service.
