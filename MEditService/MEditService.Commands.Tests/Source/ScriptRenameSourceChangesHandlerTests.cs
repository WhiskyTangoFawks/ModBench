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

    private static ScriptCopyFile InFile(string formKey, string file, string fieldPath = ScriptPath) =>
        new(formKey, Mod, [fieldPath], ScriptCopyPlace.File, file);

    private ScriptRenameSourceChanges Changes(IReadOnlyList<ScriptCopyFile> copies, IReadOnlyList<string>? unread = null) =>
        TestEditService.Over(new LoadOrderHolder(), unsaved: _unsaved).GetRequiredService<ScriptRenameSourceChangesHandler>()
            .Changes("Ns:Quest", "Ns:Renamed", copies, unread ?? []);

    [Fact]
    public void EachRecordAFileHoldsThatAttachesIt_NamesItAnew_InOneDocumentOfTheFile()
    {
        var text = $"[ {Scripted(Quest, "ns:quest")}, {Scripted(Alias, "Ns:Quest")} ]";
        var file = Saved(text);

        var changes = Changes([InFile(Quest, file), InFile(Alias, file)]);

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

        Assert.Equal([new DocumentChange(file, unsaved.Replace("Ns:Quest", "Ns:Renamed", StringComparison.Ordinal))], Changes([InFile(Quest, file)]).Documents);
    }

    [Fact]
    public void ACopyThatCannotFollow_IsLeftBehind_SayingWhy_AndNoFileChanges()
    {
        var file = Saved(Scripted(Quest, "Ns:Quest"));
        var changes = Changes(
            [
                new(Quest, new("Other.esp", "Other"), [ScriptPath], ScriptCopyPlace.NoPluginSource),
                new(Quest, new("Mod.esp", "Gone"), [ScriptPath], ScriptCopyPlace.NoCopy),
                new(Quest, new("Mod.esp", "Rendered"), [ScriptPath], ScriptCopyPlace.Rendered),
                new(Quest, new("Mod.esp", "Stopped"), [ScriptPath], ScriptCopyPlace.Unread, "Mod.esp's plugin source stopped reading."),
                InFile(Quest, file, "VirtualMachineAdapter.Scripts[1].Name"),
            ],
            [$"{Alias} in Mod.esp (Mod): mEdit has no schema for its record type xxxx"]);

        Assert.Empty(changes.Documents);
        Assert.Equal(
            [
                $"{Quest} in Other.esp (Other)",
                $"{Alias} in Mod.esp (Mod): mEdit has no schema for its record type xxxx",
                $"Mod.esp (Gone) holds no {Quest}.",
                $"{Quest} in Mod.esp (Rendered): its plugin source holds no file of it",
                "Mod.esp's plugin source stopped reading.",
                $"{Quest} in Mod.esp (Mod): its plugin source does not name Ns:Quest at VirtualMachineAdapter.Scripts[1].Name",
            ],
            changes.LeftBehind);
    }

    [Fact]
    public void ACopyWhoseFileCannotBeRead_IsLeftBehind_SayingWhy_AndTheRestFollow()
    {
        var file = Saved(Scripted(Quest, "Ns:Quest"));

        var changes = Changes([InFile(Alias, "bad\0path"), InFile(Quest, file)]);

        Assert.Equal([new DocumentChange(file, Scripted(Quest, "Ns:Renamed"))], changes.Documents);
        Assert.Equal([$"{Alias} in Mod.esp (Mod): Null character in path. (Parameter 'path')"], changes.LeftBehind);
    }
}
