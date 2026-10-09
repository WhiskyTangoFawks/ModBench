namespace MEditService.SourceAdapter.Tests.Source;

public sealed class UnsavedDocumentsTests
{
    private static readonly DocumentChange A = new("/mod/plugin-source/A.esp/A.json", "a");
    private static readonly DocumentChange B = new("/mod/plugin-source/A.esp/B.json", "b");

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
}
