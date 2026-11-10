🪟 **Windows installation & updates**

- Setup now checks access to the chosen folder and the previous installation before removing the old launcher. When administrator permission is needed, it requests elevation and checks access again.
- Cancelling elevation or encountering locked, read-only or inaccessible files stops Setup before the previous version is removed. Error messages identify the affected path and explain how to retry.
- Fixed the missing separator below the Windows title bar buttons.

🔄 **Server updates for existing folders**

- Server folders containing a Git working copy can now download and apply releases through the launcher, regardless of the current branch.
- Applying a release replaces local server code with the selected release while preserving the world databases, settings and Git metadata. Checking for or downloading an update leaves local code unchanged until you apply it.
