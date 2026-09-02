using MEditService.Core.Source;

namespace MEditService.Tests.Source;

/// <summary><see cref="SourceTreeMerge.MergeAdditively"/> — folds a scratch tree into an
/// existing destination tree without disturbing anything already there.</summary>
public sealed class SourceTreeMergeTests : IDisposable
{
    private readonly string _root = Directory.CreateTempSubdirectory("medit-merge-test-").FullName;

    public void Dispose() => Directory.Delete(_root, recursive: true);

    private string NewDir(string name)
    {
        var path = Path.Combine(_root, name);
        Directory.CreateDirectory(path);
        return path;
    }

    [Fact]
    public void MergeAdditively_CopiesEveryScratchFile_IntoAPreexistingDestinationTree_WithoutTouchingUnrelatedFiles()
    {
        var scratch = NewDir("scratch");
        var destination = NewDir("destination");

        // Pre-existing, unrelated tracked content the merge must not touch.
        var unrelatedDir = Path.Combine(destination, "Quests", "SomeQuest");
        Directory.CreateDirectory(unrelatedDir);
        var unrelatedFile = Path.Combine(unrelatedDir, "RecordData.json");
        File.WriteAllText(unrelatedFile, "{\"EditorID\":\"SomeQuest\"}");

        // New content the mint produced.
        var newCellDir = Path.Combine(scratch, "Worldspaces", "World", "3, -2", "0, -1", "NewCell");
        Directory.CreateDirectory(newCellDir);
        File.WriteAllText(Path.Combine(newCellDir, "RecordData.json"), "{\"EditorID\":\"NewCell\"}");

        SourceTreeMerge.MergeAdditively(scratch, destination);

        Assert.Equal("{\"EditorID\":\"SomeQuest\"}", File.ReadAllText(unrelatedFile));
        Assert.Equal(
            "{\"EditorID\":\"NewCell\"}",
            File.ReadAllText(Path.Combine(destination, "Worldspaces", "World", "3, -2", "0, -1", "NewCell", "RecordData.json")));
    }

    // The rival this guards against: an implementation that clears the destination tree before
    // copying (fast, and looks correct for the one-mint-into-empty-tree case) — this is the assertion
    // that catches it, since a wipe-then-copy would have deleted the unrelated Quest above.
    [Fact]
    public void MergeAdditively_NeverDeletesAnythingInTheDestination()
    {
        var scratch = NewDir("scratch2");
        var destination = NewDir("destination2");
        var survivorFile = Path.Combine(destination, "Survivor.json");
        File.WriteAllText(survivorFile, "keep me");
        File.WriteAllText(Path.Combine(scratch, "New.json"), "new");

        SourceTreeMerge.MergeAdditively(scratch, destination);

        Assert.True(File.Exists(survivorFile));
    }

    [Fact]
    public void MergeAdditively_ByteIdenticalCollision_IsANoOp()
    {
        var scratch = NewDir("scratch3");
        var destination = NewDir("destination3");
        File.WriteAllText(Path.Combine(scratch, "Same.json"), "same bytes");
        File.WriteAllText(Path.Combine(destination, "Same.json"), "same bytes");

        SourceTreeMerge.MergeAdditively(scratch, destination); // must not throw

        Assert.Equal("same bytes", File.ReadAllText(Path.Combine(destination, "Same.json")));
    }

    [Fact]
    public void MergeAdditively_DifferentContentCollision_ThrowsRatherThanOverwriting()
    {
        var scratch = NewDir("scratch4");
        var destination = NewDir("destination4");
        File.WriteAllText(Path.Combine(scratch, "Conflict.json"), "new content");
        File.WriteAllText(Path.Combine(destination, "Conflict.json"), "old content");

        Assert.Throws<InvalidOperationException>(() => SourceTreeMerge.MergeAdditively(scratch, destination));
        Assert.Equal("old content", File.ReadAllText(Path.Combine(destination, "Conflict.json")));
    }
}
