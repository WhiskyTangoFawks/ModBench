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
    private const string TrackedModName = "TrackedMod";
    private const string UntrackedModName = "UntrackedMod";
    private const string MasterName = "Master.esm";
    private static readonly PluginAddress Old = new("Old.esp", TrackedModName);
    private readonly ScratchDirectory _root = new("medit-rename-source-");
    private readonly string _game;
    private readonly string _trackedMod;
    private readonly string _untrackedMod;
    private readonly LoadOrderHolder _holder = new();

    public RenameSourceHandlerTests()
    {
        _game = Directory.CreateDirectory(Path.Combine(_root, "game")).FullName;
        _trackedMod = Directory.CreateDirectory(Path.Combine(_root, "mods", TrackedModName)).FullName;
        _untrackedMod = Directory.CreateDirectory(Path.Combine(_root, "mods", UntrackedModName)).FullName;

        var master = new Fallout4Mod(ModKey.FromFileName(MasterName), Fallout4Release.Fallout4);
        var masterNpc = master.Npcs.AddNew("MasterNpc");
        master.WriteToBinary(Path.Combine(_game, MasterName));

        var old = new Fallout4Mod(ModKey.FromFileName(Old.Name), Fallout4Release.Fallout4);
        ContainerModPlugin.AddTo(old);
        var race = old.Races.AddNew("OldRace");
        old.Npcs.AddNew("SelfNpc").Race.SetTo(race);
        old.Npcs.GetOrAddAsOverride(masterNpc).Race.SetTo(race);
        old.WriteToBinary(
            Path.Combine(_trackedMod, Old.Name),
            new BinaryWriteParameters { MastersListContent = MastersListContentOption.Iterate });
        WritePlugin(_untrackedMod, "Other.esp");

        Apply(Old.Name);
        TestEditService.TrackHandler(_holder).TrackAsync([TrackedModName]).GetAwaiter().GetResult();
        WritePlugin(_trackedMod, "Loose.esp");
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
        Assert.False(SourceRepository.SourceReads(new RegisteredPlugin(Old.Name, TrackedModName, "", new PluginProvider.FromMod(TrackedModName, _trackedMod))));
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
        var before = TrackedTree.Records(_trackedMod, Old);

        var result = RenameSource(Old, "New.txt");

        Assert.Equal(RenameSourceRefusal.NotAPluginFile, result.Refusal);
        Assert.Contains("New.txt", result.Message, StringComparison.Ordinal);
        Assert.Equal(before, TrackedTree.Records(_trackedMod, Old));
    }

    [Theory]
    [InlineData(GameRelease.Fallout4, "must be .esm, .esl or .esp.")]
    [InlineData(GameRelease.Oblivion, "must be .esm or .esp.")]
    public void RenameSource_ToANameThatIsNoPluginFile_IsRefusedNamingTheExtensionsTheReleaseTakes(GameRelease release, string expected)
    {
        var holder = new LoadOrderHolder();
        holder.Apply(SnapshotPlugins.Snapshot(_game, _root, release, []));

        var result = TestEditService.Over(holder).GetRequiredService<RenameSourceHandler>().RenameSource(Old, "New.txt");

        Assert.EndsWith(expected, result.Message, StringComparison.Ordinal);
    }

    [Fact]
    public void RenameSource_OfAPluginNotInTheLoadOrder_RefusesIt()
    {
        var result = RenameSource(new PluginAddress("NoSuch.esp", TrackedModName), "New.esp");

        Assert.Equal(RenameSourceRefusal.PluginNotLoaded, result.Refusal);
        Assert.Contains("NoSuch.esp", result.Message, StringComparison.Ordinal);
    }

    [Theory]
    [InlineData("Other.esp", UntrackedModName)]
    [InlineData("Loose.esp", TrackedModName)]
    public void RenameSource_OfAPluginWithNoPluginSource_RefusesIt_AndWritesNothing(string plugin, string origin)
    {
        var result = RenameSource(new PluginAddress(plugin, origin), "New.esp");

        Assert.Equal(RenameSourceRefusal.NotTracked, result.Refusal);
        Assert.Contains(plugin, result.Message, StringComparison.Ordinal);
        Assert.False(Directory.Exists(PluginSourceRoot.In(_trackedMod, "New.esp")));
        Assert.False(Directory.Exists(PluginSourceRoot.In(_untrackedMod, "New.esp")));
    }

    [Fact]
    public void RenameSource_ToTheNameOfAPluginSourceTheModHolds_ComparedWithoutCase_RefusesIt_AndWritesNothing()
    {
        var before = TrackedTree.Records(_trackedMod, Old);

        var result = RenameSource(Old, "OLD.ESP");

        Assert.Equal(RenameSourceRefusal.NameTaken, result.Refusal);
        Assert.Contains("OLD.ESP", result.Message, StringComparison.Ordinal);
        Assert.Equal(before, TrackedTree.Records(_trackedMod, Old));
    }

    [Fact]
    public void RenameSource_OfATreeHoldingADocumentThatIsNoJson_RefusesIt_AndWritesNothing()
    {
        var npc = TrackedTree.DocumentCarrying(_trackedMod, Old, "SelfNpc");
        TrackedTree.Overwrite(_trackedMod, Old, npc.Identity, "{ \"FormKey\": ");

        var result = RenameSource(Old, "New.esp");

        Assert.Equal(RenameSourceRefusal.UnreadableSource, result.Refusal);
        Assert.Contains("SelfNpc", result.Message, StringComparison.Ordinal);
        Assert.True(SourceRepository.SourceReads(new RegisteredPlugin(Old.Name, TrackedModName, "", new PluginProvider.FromMod(TrackedModName, _trackedMod))));
        Assert.False(SourceRepository.SourceReads(new RegisteredPlugin("New.esp", TrackedModName, "", new PluginProvider.FromMod(TrackedModName, _trackedMod))));
    }

    [Fact]
    public void RenameSource_WhenGitRefusesTheWrite_RefusesIt_AndPutsTheSourceBack()
    {
        var before = TrackedTree.Records(_trackedMod, Old);
        File.WriteAllText(Path.Combine(_trackedMod, ".git", "refs", "medit", "last-compile", "New.esp.lock"), "");

        var result = RenameSource(Old, "New.esp");

        Assert.Equal(RenameSourceRefusal.WriteFailed, result.Refusal);
        Assert.Contains(Old.Name, result.Message, StringComparison.Ordinal);
        Assert.Equal(before, TrackedTree.Records(_trackedMod, Old));
        Assert.False(SourceRepository.SourceReads(new RegisteredPlugin("New.esp", TrackedModName, "", new PluginProvider.FromMod(TrackedModName, _trackedMod))));
    }

    private RenameSourceResult RenameSource(PluginAddress plugin, string newName) =>
        TestEditService.Over(_holder).GetRequiredService<RenameSourceHandler>().RenameSource(plugin, newName);

    private async Task<byte[]> CompiledBytes(PluginAddress plugin)
    {
        var compiled = await TestEditService.CompileHandler(_holder).CompileAsync([plugin]);
        Assert.Empty(compiled.Refused);
        return File.ReadAllBytes(Path.Combine(_trackedMod, plugin.Name));
    }

    private void TheInstanceAdapterRenamesTheFile(string newName)
    {
        File.Move(Path.Combine(_trackedMod, Old.Name), Path.Combine(_trackedMod, newName));
        Apply(newName);
    }

    private void Apply(string trackedPlugin)
    {
        List<LoadOrderEntry> entries =
        [
            new(MasterName, Path.Combine(_game, MasterName), PluginOrigin.DataDirectory, 0, Enabled: true, Winning: true),
            new(trackedPlugin, Path.Combine(_trackedMod, trackedPlugin), TrackedModName, 1, Enabled: true, Winning: true),
            new("Other.esp", Path.Combine(_untrackedMod, "Other.esp"), UntrackedModName, 2, Enabled: true, Winning: true),
        ];
        if (File.Exists(Path.Combine(_trackedMod, "Loose.esp")))
            entries.Add(new("Loose.esp", Path.Combine(_trackedMod, "Loose.esp"), TrackedModName, 3, Enabled: true, Winning: true));
        _holder.Apply(SnapshotPlugins.Snapshot(_game, _root, GameRelease.Fallout4, entries));
    }

    private static void WritePlugin(string modFolder, string name)
    {
        var mod = new Fallout4Mod(ModKey.FromFileName(name), Fallout4Release.Fallout4);
        mod.Npcs.AddNew($"{Path.GetFileNameWithoutExtension(name)}Npc");
        mod.WriteToBinary(Path.Combine(modFolder, name));
    }

    private SourceRepository Repository =>
        SourceRepository.Open(new PluginProvider.FromMod(TrackedModName, _trackedMod), GameRelease.Fallout4).Require();
}
