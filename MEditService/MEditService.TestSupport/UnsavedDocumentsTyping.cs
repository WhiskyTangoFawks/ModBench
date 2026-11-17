using MEditService.SourceAdapter;

namespace MEditService.TestSupport;

/// <summary>A test types into and closes a document as VS Code does, each at a version above the last.</summary>
public static class UnsavedDocumentsTyping
{
    private static long _version;

    public static long NextVersion() => Interlocked.Increment(ref _version);

    public static void Typed(this UnsavedDocuments unsaved, DocumentChange document) =>
        unsaved.Hold(document, NextVersion(), opened: false, out _);

    public static void Closed(this UnsavedDocuments unsaved, string path) => unsaved.Drop(path, out _);
}
