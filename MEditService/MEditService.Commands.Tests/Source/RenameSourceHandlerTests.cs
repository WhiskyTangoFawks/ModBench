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
    private static readonly PluginAddress Patch = new("Patch.esp", SourceModName);
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
        var patch = new Fallout4Mod(ModKey.FromFileName(Patch.Name), Fallout4Release.Fallout4);
        patch.Npcs.AddNew("PatchNpc").Race.SetTo(race);
        patch.WriteToBinary(
            Path.Combine(_sourceMod, Patch.Name),
            new BinaryWriteParameters { MastersListContent = MastersListContentOption.Iterate });

        Apply(Old.Name);
        TestEditService.VersionInGitHandler(_holder).VersionInGitAsync(ToVersionInGit.In(_holder.Held?.Snapshot, SourceModName)).GetAwaiter().GetResult().Value();
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
    public async Task RenameSource_AnotherPluginSourceThatNamesIt_FollowsIt_SoItCompilesAgainstTheNewName()
    {
        var result = RenameSource(Old, "New.esp");

        Assert.Empty(result.Changes.Require().LeftBehind);
        TheInstanceAdapterRenamesTheFile("New.esp");
        await CompiledBytes(Patch);
        using var compiled = Fallout4Mod.CreateFromBinaryOverlay(Path.Combine(_sourceMod, Patch.Name), Fallout4Release.Fallout4);
        Assert.Equal(["New.esp"], compiled.ModHeader.MasterReferences.Select(master => master.Master.FileName.String));
    }

    [Fact]
    public void RenameSource_OfACopyItsFileNameDoesNotName_LeavesEveryOtherPluginSourceNamingTheCopyThatWins()
    {
        var result = new Read(Changes.RenameSource(Old, "New.esp", namedByFileName: false, sourceFiles: []));

        var changes = result.Changes.Require();
        Assert.NotEmpty(changes.Moves);
        Assert.DoesNotContain(changes.Documents, document => document.Path.StartsWith(PluginSourceRoot.In(_sourceMod, Patch.Name), StringComparison.Ordinal));
    }

    [Fact]
    public void RenameSource_AnotherPluginSourceThatDoesNotRead_IsLeftBehind_NamingWhy_AndTheRenameLands()
    {
        var npc = SourceModTree.DocumentCarrying(_sourceMod, Patch, "PatchNpc");
        SourceModTree.Overwrite(_sourceMod, Patch, npc.Identity, "{ \"FormKey\": ");

        var result = new Read(Changes.RenameSource(Old, "New.esp", namedByFileName: true, sourceFiles: []));

        Assert.Null(result.Refusal);
        var left = Assert.Single(result.Changes.Require().LeftBehind);
        Assert.Equal(Patch, left.Plugin);
        Assert.Contains("PatchNpc", left.Reason, StringComparison.Ordinal);
        Assert.NotEmpty(result.Changes.Require().Moves);
    }

    [Fact]
    public void RenameSource_MovesEachFileOfTheSourceFolderItIsHanded_ThatTheFolderHolds()
    {
        File.WriteAllText(Path.Combine(_sourceMod, "Old - Main.ba2"), "archive");

        var result = new Read(Changes.RenameSource(Old, "New.esp", namedByFileName: true,
            sourceFiles: [new SourceMove("Old - Main.ba2", "New - Main.ba2"), new SourceMove("Old.esp.bak", "New.esp.bak")]));

        Assert.Contains(new SourceMove(Path.Combine(_sourceMod, "Old - Main.ba2"), Path.Combine(_sourceMod, "New - Main.ba2")), result.Changes.Require().Moves);
        Assert.DoesNotContain(result.Changes.Require().Moves, move => move.From.EndsWith(".bak", StringComparison.Ordinal));
    }

    [Fact]
    public void RenameSource_ToAFileNameTheSourceFolderHolds_RefusesIt_AndWritesNothing()
    {
        File.WriteAllText(Path.Combine(_sourceMod, "Old - Main.ba2"), "archive");
        File.WriteAllText(Path.Combine(_sourceMod, "New - Main.ba2"), "another archive");

        var result = new Read(Changes.RenameSource(Old, "New.esp", namedByFileName: true, sourceFiles: [new SourceMove("Old - Main.ba2", "New - Main.ba2")]));

        Assert.Equal(RenameSourceRefusal.NameTaken, result.Refusal);
        Assert.Contains("New - Main.ba2", result.Message, StringComparison.Ordinal);
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
    public void RenameSource_OfAPluginWithNoPluginSource_AnswersNoChanges_AndMovesNothing(string plugin, string origin)
    {
        var result = RenameSource(new PluginAddress(plugin, origin), "New.esp");

        var changes = result.Changes.Require();
        Assert.Null(result.Refusal);
        Assert.Equal(0, changes.Moves.Count + changes.Deletions.Count + changes.Documents.Count + changes.LeftBehind.Count);
        Assert.False(Directory.Exists(PluginSourceRoot.In(_sourceMod, "New.esp")));
        Assert.False(Directory.Exists(PluginSourceRoot.In(_nonSourceMod, "New.esp")));
    }

    [Fact]
    public void RenameSource_OfAPluginInNoMod_RefusesIt()
    {
        var result = RenameSource(new PluginAddress(MasterName, PluginOrigin.DataDirectory), "New.esm");

        Assert.Equal(RenameSourceRefusal.NotInAMod, result.Refusal);
        Assert.Contains(MasterName, result.Message, StringComparison.Ordinal);
    }

    [PosixFact]
    public void RenameSource_OfAPluginWhoseSourceHasTwinFolders_RefusesItNamingThem_AndWritesNothing()
    {
        var sources = Path.GetDirectoryName(PluginSourceRoot.In(_sourceMod, Old.Name)).Require();
        Directory.Move(Path.Combine(sources, Old.Name), Path.Combine(sources, "OLD.ESP"));
        Directory.CreateDirectory(Path.Combine(sources, "old.esp"));

        var result = RenameSource(Old, "New.esp");

        Assert.Equal(RenameSourceRefusal.UnreadableSource, result.Refusal);
        Assert.Contains("OLD.ESP and old.esp", result.Message, StringComparison.Ordinal);
        Assert.False(Directory.Exists(PluginSourceRoot.In(_sourceMod, "New.esp")));
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

        var result = new Read(TestEditService.Over(_holder, unsaved: unsaved).GetRequiredService<RenameSourceChangesHandler>().RenameSource(Old, "New.esp", namedByFileName: true, sourceFiles: []));

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
    public void MoveLastWritten_OfAPluginInAModThatIsNoSourceMod_HasNothingToMove_AndRefusesNothing()
    {
        var result = Moving.MoveLastWritten(new PluginAddress("Other.esp", NonSourceModName), "Other.esp", "New.esp");

        Assert.Null(result.Refusal);
    }

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
        var answered = new Read(Changes.RenameSource(plugin, newName, namedByFileName: true, sourceFiles: []));
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
            new(Patch.Name, Path.Combine(_sourceMod, Patch.Name), SourceModName, 3, Enabled: true, Winning: true),
        ];
        if (File.Exists(Path.Combine(_sourceMod, "Loose.esp")))
            entries.Add(new("Loose.esp", Path.Combine(_sourceMod, "Loose.esp"), SourceModName, 4, Enabled: true, Winning: true));
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
