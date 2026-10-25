using MEditService.Commands.Tests.TestSupport;
using MEditService.LoadOrder;
using MEditService.SourceAdapter;
using MEditService.TestSupport;
using Microsoft.Extensions.DependencyInjection;
using Mutagen.Bethesda;
using Mutagen.Bethesda.Fallout4;
using Mutagen.Bethesda.Plugins;
using Mutagen.Bethesda.Plugins.Binary.Parameters;

namespace MEditService.Commands.Tests.Source;

public sealed class RenameSourceHandlerTests : IDisposable
{
    private const string SourceModName = "SourceMod";
    private const string NonSourceModName = "NonSourceMod";
    private const string MasterName = "Master.esm";
    private static readonly PluginAddress Old = new("Old.esp", SourceModName);
    private readonly ScratchDirectory _root = new("medit-rename-source-");
    private readonly string _dataFolder;
    private readonly string _sourceMod;
    private readonly string _nonSourceMod;
    private readonly LoadOrderHolder _holder = new();

    public RenameSourceHandlerTests()
    {
        _dataFolder = Directory.CreateDirectory(Path.Combine(_root, "Data")).FullName;
        _sourceMod = Directory.CreateDirectory(Path.Combine(_root, "mods", SourceModName)).FullName;
        _nonSourceMod = Directory.CreateDirectory(Path.Combine(_root, "mods", NonSourceModName)).FullName;

        var master = new Fallout4Mod(ModKey.FromFileName(MasterName), Fallout4Release.Fallout4);
        var masterNpc = master.Npcs.AddNew("MasterNpc");
        master.WriteToBinary(Path.Combine(_dataFolder, MasterName));

        var old = new Fallout4Mod(ModKey.FromFileName(Old.Name), Fallout4Release.Fallout4);
        ContainerModPlugin.AddTo(old);
        var race = old.Races.AddNew("OldRace");
        old.Npcs.AddNew("SelfNpc").Race.SetTo(race);
        old.Npcs.GetOrAddAsOverride(masterNpc).Race.SetTo(race);
        old.WriteToBinary(
            Path.Combine(_sourceMod, Old.Name),
            new BinaryWriteParameters { MastersListContent = MastersListContentOption.Iterate });
        WritePlugin(_nonSourceMod, "Other.esp");

        Apply(Old.Name);
        TestEditService.DecompileAndCommitModHandler(_holder).DecompileAndCommitAsync(ToDecompileAndCommit.In(_holder.Held?.Snapshot, SourceModName)).GetAwaiter().GetResult().Value();
        WritePlugin(_sourceMod, "Loose.esp");
        Apply(Old.Name);
    }

    public void Dispose() => _root.Dispose();

    [Theory]
    [InlineData("New.esp")]
    [InlineData("New.esm")]
    public async Task RenameSource_ThenTheFileRenamedToMatch_CompilesToTheBytesTheOldNameCompiledTo(string newName)
    {
        var compiledBefore = await CompiledBytes(Old);

        var result = RenameSource(Old, newName);

        Assert.Null(result.Refusal);
        Assert.False(SourceReads(Old.Name));
        TheInstanceAdapterRenamesTheFile(newName);
        Assert.Equal(compiledBefore, await CompiledBytes(Old with { Name = newName }));
    }

    [Fact]
    public async Task RenameSource_MovesWhatModbenchLastWrote_SoTheRenamedFileReadsAsOneModbenchWrote()
    {
        await CompiledBytes(Old);

        RenameSource(Old, "New.esp");

        TheInstanceAdapterRenamesTheFile("New.esp");
        Assert.Empty(ExternalChanges.NamedBy(_holder.Current));
    }

    [Fact]
    public void RenameSource_ToANameThatIsNoPluginFile_RefusesIt_AndWritesNothing()
    {
        var before = SourceModTree.Records(_sourceMod, Old);

        var result = RenameSource(Old, "New.txt");

        Assert.Equal(RenameSourceRefusal.NotAPluginFile, result.Refusal);
        Assert.Contains("New.txt", result.Message, StringComparison.Ordinal);
        Assert.Equal(before, SourceModTree.Records(_sourceMod, Old));
    }

    [Fact]
    public void RenameSource_OfAPluginNotInTheLoadOrder_RefusesIt()
    {
        var result = RenameSource(new PluginAddress("NoSuch.esp", SourceModName), "New.esp");

        Assert.Equal(RenameSourceRefusal.PluginNotLoaded, result.Refusal);
        Assert.Contains("NoSuch.esp", result.Message, StringComparison.Ordinal);
    }

    [Theory]
    [InlineData("Other.esp", NonSourceModName)]
    [InlineData("Loose.esp", SourceModName)]
    public void RenameSource_OfAPluginWithNoPluginSource_RefusesIt_AndWritesNothing(string plugin, string origin)
    {
        var result = RenameSource(new PluginAddress(plugin, origin), "New.esp");

        Assert.Equal(RenameSourceRefusal.NotCompiledPlugin, result.Refusal);
        Assert.Contains(plugin, result.Message, StringComparison.Ordinal);
        Assert.False(Directory.Exists(PluginSourceRoot.In(_sourceMod, "New.esp")));
        Assert.False(Directory.Exists(PluginSourceRoot.In(_nonSourceMod, "New.esp")));
    }

    [Fact]
    public void RenameSource_ToANameTheModsSourceHolds_RefusesItAsNameTaken_AndWritesNothing()
    {
        var before = SourceModTree.Records(_sourceMod, Old);

        var result = RenameSource(Old, "OLD.ESP");

        Assert.Equal(RenameSourceRefusal.NameTaken, result.Refusal);
        Assert.Contains("OLD.ESP", result.Message, StringComparison.Ordinal);
        Assert.Equal(before, SourceModTree.Records(_sourceMod, Old));
    }

    [Fact]
    public void RenameSource_OfATreeHoldingADocumentThatIsNoJson_RefusesIt_AndWritesNothing()
    {
        var npc = SourceModTree.DocumentCarrying(_sourceMod, Old, "SelfNpc");
        SourceModTree.Overwrite(_sourceMod, Old, npc.Identity, "{ \"FormKey\": ");

        var result = RenameSource(Old, "New.esp");

        Assert.Equal(RenameSourceRefusal.UnreadableSource, result.Refusal);
        Assert.Contains("SelfNpc", result.Message, StringComparison.Ordinal);
        Assert.True(SourceReads(Old.Name));
        Assert.False(SourceReads("New.esp"));
    }

    [Fact]
    public void RenameSource_AnswersTheChangesOverTheUnsavedTexts_AndWritesNothing()
    {
        var before = SourceModTree.Records(_sourceMod, Old);
        var npc = SourceModTree.DocumentCarrying(_sourceMod, Old, "SelfNpc");
        var path = Path.Combine(_sourceMod, SourceModTree.DocumentFile(_sourceMod, Old, npc.FormKey).Require());

        var unsaved = new UnsavedDocuments();
        unsaved.Apply([new DocumentChange(path, npc.Body.Replace("SelfNpc", "Unsaved", StringComparison.Ordinal))]);

        var result = new Read(TestEditService.Over(_holder, unsaved: unsaved).GetRequiredService<RenameSourceChangesHandler>().RenameSource(Old, "New.esp"));

        Assert.Null(result.Refusal);
        Assert.Contains(result.Changes.Require().Documents, document => document.Text.Contains("Unsaved", StringComparison.Ordinal));
        Assert.Equal(before, SourceModTree.Records(_sourceMod, Old));
        Assert.True(SourceReads(Old.Name));
    }

    [Fact]
    public void MoveLastWritten_WhenGitRefusesTheRefUpdate_RefusesIt()
    {
        GitHooks.RefuseRefUpdates(_sourceMod);

        var result = Moving.MoveLastWritten(Old, Old.Name, "New.esp");

        Assert.Equal(RenameSourceRefusal.WriteFailed, result.Refusal);
        Assert.Contains(Old.Name, result.Message, StringComparison.Ordinal);
    }

    private RenameSourceChangesHandler Changes => TestEditService.Over(_holder).GetRequiredService<RenameSourceChangesHandler>();

    private MoveLastWrittenHandler Moving => TestEditService.Over(_holder).GetRequiredService<MoveLastWrittenHandler>();

    [Fact]
    public void MoveLastWritten_ForATreeNameSpelledInAnotherCase_IsAccepted()
    {
        Directory.Move(PluginSourceRoot.In(_sourceMod, Old.Name), Path.Combine(_sourceMod, "plugin-source", "OLD.ESP"));

        var result = Moving.MoveLastWritten(Old, "OLD.ESP", "New.esp");

        Assert.Null(result.Refusal);
    }

    [Fact]
    public void MoveLastWritten_ForATreeNameThatIsNoSpellingOfThePlugin_RefusesIt_AndMovesNothing()
    {
        var result = Moving.MoveLastWritten(Old, "Other.esp", "New.esp");

        Assert.Equal(RenameSourceRefusal.TreeNameNotThePlugins, result.Refusal);
        Assert.Contains("Other.esp", result.Message, StringComparison.Ordinal);
    }

    private sealed record Read(RenameSourceRefusal? Refusal, string? Message, RenameSourceChanges? Changes)
    {
        internal Read(RenameSourceResult result)
            : this(result.Match<Read>(changes => new(null, null, changes), (refusal, message) => new(refusal, message, null)))
        {
        }
    }

    private Read RenameSource(PluginAddress plugin, string newName)
    {
        var answered = new Read(Changes.RenameSource(plugin, newName));
        if (answered.Changes is not { } changes) return answered;

        EditSaving.Save(
            changes.Moves.Select(move => (move.From, move.To)), changes.Deletions,
            changes.Documents.Select(document => (document.Path, document.Text)));
        var moved = Moving.MoveLastWritten(plugin, changes.TreeName, newName);
        return moved.Refusal is null ? answered : new Read(moved.Refusal, moved.Message, null);
    }

    private async Task<byte[]> CompiledBytes(PluginAddress plugin)
    {
        var compiled = (await TestEditService.CompileHandler(_holder).CompileAsync([plugin])).Value();
        Assert.Empty(compiled.Refused);
        return File.ReadAllBytes(Path.Combine(_sourceMod, plugin.Name));
    }

    private void TheInstanceAdapterRenamesTheFile(string newName)
    {
        File.Move(Path.Combine(_sourceMod, Old.Name), Path.Combine(_sourceMod, newName));
        Apply(newName);
    }

    private void Apply(string compiledPlugin)
    {
        List<LoadOrderEntry> entries =
        [
            new(MasterName, Path.Combine(_dataFolder, MasterName), PluginOrigin.DataDirectory, 0, Enabled: true, Winning: true),
            new(compiledPlugin, Path.Combine(_sourceMod, compiledPlugin), SourceModName, 1, Enabled: true, Winning: true),
            new("Other.esp", Path.Combine(_nonSourceMod, "Other.esp"), NonSourceModName, 2, Enabled: true, Winning: true),
        ];
        if (File.Exists(Path.Combine(_sourceMod, "Loose.esp")))
            entries.Add(new("Loose.esp", Path.Combine(_sourceMod, "Loose.esp"), SourceModName, 3, Enabled: true, Winning: true));
        _holder.Apply(SnapshotPlugins.Snapshot(_dataFolder, _root, GameRelease.Fallout4, entries));
    }

    private static void WritePlugin(string modFolder, string name)
    {
        var mod = new Fallout4Mod(ModKey.FromFileName(name), Fallout4Release.Fallout4);
        mod.Npcs.AddNew($"{Path.GetFileNameWithoutExtension(name)}Npc");
        mod.WriteToBinary(Path.Combine(modFolder, name));
    }

    private bool SourceReads(string pluginName) =>
        TestAdapters.Source().SourceReads(
            new RegisteredPlugin(pluginName, SourceModName, "", new PluginProvider.FromMod(SourceModName, _sourceMod, _sourceMod), Line: null, PluginStrings.None));
}
