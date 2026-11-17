namespace MEditService.SourceAdapter.Tests.Source;

public sealed class UnsavedDocumentsTests
{
    private static readonly DocumentChange A = new(Path.GetFullPath("A.json"), "a");
    private static readonly DocumentChange B = new(Path.GetFullPath("B.json"), "b");

    private readonly UnsavedDocuments _unsaved = new();

    [Fact]
    public void ADocumentHeld_StandsAlongsideTheOthers_AndReplacesItsOwnEarlierText()
    {
        _unsaved.Hold(A, 1, opened: true, out _);
        _unsaved.Hold(B, 2, opened: true, out _);
        _unsaved.Hold(A with { Text = "typed" }, 3, opened: false, out var changed);

        Assert.True(changed);
        Assert.Equal([A with { Text = "typed" }, B], _unsaved.Current);
    }

    [Fact]
    public void TheTextAlreadyHeld_IsNoChange()
    {
        _unsaved.Hold(A, 1, opened: true, out _);

        _unsaved.Hold(A, 2, opened: false, out var changed);

        Assert.False(changed);
    }

    [Fact]
    public void AChangeOfAnOlderVersion_IsIgnored()
    {
        _unsaved.Hold(A with { Text = "newer" }, 5, opened: true, out _);

        _unsaved.Hold(A, 4, opened: false, out var changed);

        Assert.False(changed);
        Assert.Equal([A with { Text = "newer" }], _unsaved.Current);
    }

    [Fact]
    public void AnOpenOfAnOlderVersion_ReplacesTheDocumentHeld()
    {
        _unsaved.Hold(A with { Text = "before the reload" }, 5, opened: true, out _);

        _unsaved.Hold(A, 1, opened: true, out var changed);

        Assert.True(changed);
        Assert.Equal([A], _unsaved.Current);
    }

    [Fact]
    public void ADocumentDropped_IsHeldNoMore_AndTheOthersStay()
    {
        _unsaved.Hold(A, 1, opened: true, out _);
        _unsaved.Hold(B, 2, opened: true, out _);

        _unsaved.Drop(A.Path, out var changed);

        Assert.True(changed);
        Assert.Equal([B], _unsaved.Current);
    }

    [Fact]
    public void ADocumentNeverHeld_IsNoChangeToDrop()
    {
        _unsaved.Drop(A.Path, out var changed);

        Assert.False(changed);
    }

    [Fact]
    public void ADocumentByARelativePath_IsRefused_AndNothingNewIsHeld()
    {
        _unsaved.Hold(A, 1, opened: true, out _);

        var held = _unsaved.Hold(new DocumentChange("plugin-source/C.json", "c"), 2, opened: true, out var heldChanged);
        var dropped = _unsaved.Drop("plugin-source/C.json", out var droppedChanged);

        Assert.Equal("Name each document by its absolute path.", held?.Message);
        Assert.Equal("Name each document by its absolute path.", dropped?.Message);
        Assert.False(heldChanged || droppedChanged);
        Assert.Equal([A], _unsaved.Current);
    }
}
