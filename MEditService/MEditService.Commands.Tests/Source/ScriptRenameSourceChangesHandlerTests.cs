using MEditService.Commands.Tests.TestSupport;
using MEditService.LoadOrder;
using MEditService.SourceAdapter;
using MEditService.TestSupport;
using Microsoft.Extensions.DependencyInjection;

namespace MEditService.Commands.Tests.Source;

public sealed class ScriptRenameSourceChangesHandlerTests : IDisposable
{
    private const string Quest = "000801:Mod.esp";
    private const string Alias = "000802:Mod.esp";
    private const string ScriptPath = "VirtualMachineAdapter.Scripts[0].Name";
    private static readonly PluginAddress Mod = new("Mod.esp", "Mod");
    private readonly ScratchDirectory _root = new("medit-script-rename-");
    private readonly UnsavedDocuments _unsaved = new();

    public void Dispose() => _root.Dispose();

    private static string Scripted(string formKey, string name) =>
        $$"""{ "FormKey": "{{formKey}}", "VirtualMachineAdapter": { "Scripts": [ { "Name": "{{name}}" } ] } }""";

    private string Saved(string text)
    {
        var file = Path.Combine(_root, "Quest.json");
        File.WriteAllText(file, text);
        return file;
    }

    private ScriptRenameSourceChanges Changes(params ScriptCopyFile[] copies) =>
        TestEditService.Over(new LoadOrderHolder(), unsaved: _unsaved).GetRequiredService<ScriptRenameSourceChangesHandler>()
            .Changes("Ns:Quest", "Ns:Renamed", copies);

    [Fact]
    public void EachRecordAFileHoldsThatAttachesIt_NamesItAnew_InOneDocumentOfTheFile()
    {
        var text = $"[ {Scripted(Quest, "ns:quest")}, {Scripted(Alias, "Ns:Quest")} ]";
        var file = Saved(text);

        var changes = Changes(new(Quest, Mod, [ScriptPath], file), new(Alias, Mod, [ScriptPath], file));

        Assert.Equal(
            [new DocumentChange(file, text.Replace("ns:quest", "Ns:Renamed", StringComparison.Ordinal).Replace("Ns:Quest", "Ns:Renamed", StringComparison.Ordinal))],
            changes.Documents);
        Assert.Equal([Mod], changes.Plugins);
        Assert.Empty(changes.LeftBehind);
    }

    [Fact]
    public void AnUnsavedDocument_IsReadInPlaceOfItsFile()
    {
        var file = Saved(Scripted(Quest, "Ns:Quest"));
        var unsaved = $"[ {Scripted(Quest, "Ns:Quest")} ]";
        _unsaved.Apply([new DocumentChange(file, unsaved)]);

        Assert.Equal([new DocumentChange(file, unsaved.Replace("Ns:Quest", "Ns:Renamed", StringComparison.Ordinal))], Changes(new ScriptCopyFile(Quest, Mod, [ScriptPath], file)).Documents);
    }

    [Fact]
    public void ARecordWhoseFileDoesNotNameItWhereTheRecordIndexSays_IsLeftBehind_SayingWhy()
    {
        var changes = Changes(new ScriptCopyFile(Quest, Mod, ["VirtualMachineAdapter.Scripts[1].Name"], Saved(Scripted(Quest, "Ns:Quest"))));

        Assert.Empty(changes.Documents);
        Assert.Equal([$"{Quest} in Mod.esp (Mod): its plugin source does not name Ns:Quest at VirtualMachineAdapter.Scripts[1].Name"], changes.LeftBehind);
    }
}
