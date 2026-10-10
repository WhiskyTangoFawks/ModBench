namespace MEditService.SourceAdapter.Tests.Source;

public sealed class UnsavedDocumentsTests
{
    private static readonly DocumentChange A = new(Path.Combine(Path.GetTempPath(), "A.json"), "a");
    private static readonly DocumentChange B = new(Path.Combine(Path.GetTempPath(), "B.json"), "b");

    private readonly UnsavedDocuments _unsaved = new();
    private readonly List<string[]> _arrivals = [];

    public UnsavedDocumentsTests() => _unsaved.Arrived += paths => _arrivals.Add([.. paths]);

    [Fact]
    public void Apply_ReportsTheDocumentsWhoseTextChanged_WereHanded_OrWereDropped()
    {
        _unsaved.Apply([A, B]);
        _unsaved.Apply([A, B with { Text = "typed" }]);
        _unsaved.Apply([A]);

        Assert.Equal([[A.Path, B.Path], [B.Path], [B.Path]], _arrivals);
    }

    [Fact]
    public void Apply_OfTheSetAlreadyHeld_ReportsNothing()
    {
        _unsaved.Apply([A, B]);
        _arrivals.Clear();

        _unsaved.Apply([B, A]);

        Assert.Empty(_arrivals);
    }

    [Fact]
    public void Apply_OfADocumentByARelativePath_RefusesAndHoldsNothingNew()
    {
        _unsaved.Apply([A]);
        _arrivals.Clear();

        var refused = _unsaved.Apply([B, new DocumentChange("plugin-source/C.json", "c")]);

        Assert.Equal("Name each document by its absolute path.", refused?.Message);
        Assert.Equal([A], _unsaved.Current);
        Assert.Empty(_arrivals);
    }

    [Fact]
    public void Apply_OfNoSet_Refuses_ForWithoutOneTheIndexWouldReadTheDisk()
    {
        var refused = _unsaved.Apply(null);

        Assert.Equal("The unsaved documents are required, empty when none are dirty.", refused?.Message);
    }

    [Fact]
    public void Apply_OfAnAbsoluteSet_Accepts()
    {
        Assert.Null(_unsaved.Apply([A, B]));
    }
}
