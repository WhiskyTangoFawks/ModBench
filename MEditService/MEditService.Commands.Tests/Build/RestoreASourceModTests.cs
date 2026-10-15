using MEditService.Commands.Build;
using MEditService.Commands.Edits;
using MEditService.Commands.Tests.TestSupport;
using MEditService.LoadOrder;
using MEditService.ModFolderAdapter;
using MEditService.SourceAdapter;
using MEditService.TestSupport;
using Mutagen.Bethesda;
using Mutagen.Bethesda.Fallout4;
using Mutagen.Bethesda.Plugins;

namespace MEditService.Commands.Tests.Build;

public sealed class RestoreASourceModTests : IDisposable
{
    private const string ModName = "Mod";

    private readonly ScratchDirectory _root = new("medit-restore-source-mod-");
    private readonly LoadOrderHolder _holder = new();
    private readonly ModFolderRepository _folders = new(TimeProvider.System);
    private readonly string _first;
    private readonly string _second;

    public RestoreASourceModTests()
    {
        Directory.CreateDirectory(RemoteFolder);
        Git(RemoteFolder, "init", "-q", "-b", "main");
        _first = Commit("{\"output\": \"Mod\"}", "first");
        _second = Commit("{\"output\": \"Mod\"}", "second");
        Directory.CreateDirectory(ModFolder);
        File.WriteAllText(Path.Combine(ModFolder, "meta.ini"), "[General]");
        _holder.Apply(SnapshotPlugins.Snapshot(_root, _root, GameRelease.Fallout4, []));
    }

    public void Dispose() => _root.Dispose();

    private string RemoteFolder => Path.Combine(_root, "remote");

    private string ModFolder => Path.Combine(_root, "mods", ModName);

    private string SourceFolder => Path.Combine(_root, "source", ModName);

    [Fact]
    public async Task AnAbsentSource_IsClonedAndBuiltAtTheCommitItsManifestNames_NamingEachFileNoLineNames()
    {
        ManifestedAt(_first);
        File.WriteAllText(Path.Combine(ModFolder, "notes.txt"), "mine");

        var restored = Assert.Single((await Restore()).Landed).Outcome;

        Assert.Equal("first", File.ReadAllText(Path.Combine(ModFolder, "meshes", "c.nif")));
        Assert.Equal(_first, Git(SourceFolder, "rev-parse", "HEAD").Trim());
        Assert.Equal(["meshes/c.nif"], restored.Written);
        Assert.Equal(["notes.txt"], restored.NamedByNoLine);
    }

    [Fact]
    public async Task APluginWhoseSourceTheLoadOrderDoesNotKnow_IsCompiledFromTheSourceRestoreCloned()
    {
        var plugin = await ManifestedPluginSource();
        var changed = new Fallout4Mod(ModKey.FromFileName("Fixture.esp"), Fallout4Release.Fallout4);
        changed.Doors.AddNew("ChangedOutsideModbench");
        changed.WriteToBinary(plugin);
        var changedBytes = File.ReadAllBytes(plugin);
        _holder.Apply(SnapshotPlugins.Snapshot(_root, _root, GameRelease.Fallout4,
            [new LoadOrderEntry("Fixture.esp", plugin, ModName, 0, Enabled: true, Winning: true, NamedProvider: new PluginProvider.FromMod(ModName, ModFolder, null))]));

        Assert.Single((await Restore()).Landed);

        Assert.NotEqual(changedBytes, File.ReadAllBytes(plugin));
    }

    private async Task<string> ManifestedPluginSource()
    {
        var remote = Path.Combine(_root, "plugin-remote");
        var plugin = Path.Combine(ModFolder, "Fixture.esp");
        var written = new Fallout4Mod(ModKey.FromFileName("Fixture.esp"), Fallout4Release.Fallout4);
        written.Doors.AddNew("FixtureDoor");
        written.WriteToBinary(plugin);
        _holder.Apply(SnapshotPlugins.Snapshot(_root, _root, GameRelease.Fallout4,
            [new LoadOrderEntry("Fixture.esp", plugin, ModName, 0, Enabled: true, Winning: true, NamedProvider: new PluginProvider.FromMod(ModName, ModFolder, remote))]));
        Assert.Single((await TestEditService.InitHandler(_holder).InitAsync([new ModToInit(ModName, remote, [], [])])).Landed);
        _folders.WriteManifest(ModFolder, ModName, new Manifest([], [], [new ManifestFile("Fixture.esp", new FileProvider.Source(remote, Git(remote, "rev-parse", "HEAD").Trim()))]));
        return plugin;
    }

    [Fact]
    public async Task ASourceAtTheCommitThatHoldsChangesNoCommitHolds_IsBuilt_AndSaysSo()
    {
        const string Shared = "https://example.com/mod.git";
        Assert.Equal(_first, TestAdapters.Source().CommitAtHead(SourceFolder, new SharedSource(RemoteFolder, _first), CancellationToken.None).Value());
        Git(SourceFolder, "remote", "set-url", "origin", Shared);
        File.WriteAllText(Path.Combine(SourceFolder, "assets", "meshes", "c.nif"), "changed");
        ManifestedAt(_first, Shared);

        var restored = Assert.Single((await Restore()).Landed).Outcome;

        Assert.True(restored.Uncommitted);
        Assert.Equal("changed", File.ReadAllText(Path.Combine(ModFolder, "meshes", "c.nif")));
    }

    [Fact]
    public async Task ASourceAtAnotherCommit_IsSkippedNamingTheCommit_AndNothingIsWritten()
    {
        Assert.Equal(_second, TestAdapters.Source().CommitAtHead(SourceFolder, new SharedSource(RemoteFolder, _second), CancellationToken.None).Value());
        ManifestedAt(_first);

        var skipped = Assert.Single((await Restore()).Refused);

        Assert.Equal(
            (RestoreRefusal.SourceAtAnotherCommit, $"'{ModName}' was skipped: its source is at {_second}, not at {_first}, the commit its manifest names."),
            (skipped.Refusal.Kind, skipped.Message));
        Assert.False(File.Exists(Path.Combine(ModFolder, "meshes", "c.nif")));
    }

    [Fact]
    public async Task ASourceThatCannotBeCloned_IsSkippedSayingWhy()
    {
        ManifestedAt(_first, remote: Path.Combine(_root, "gone"));

        var skipped = Assert.Single((await Restore()).Refused);

        Assert.Equal(
            (RestoreRefusal.SourceUnavailable, $"'{ModName}' was skipped: its source could not be cloned or read: git clone failed (128)."),
            (skipped.Refusal.Kind, skipped.Message));
    }

    [Fact]
    public async Task ASourceWhoseBuildRefusesTheMod_IsSkippedWithTheBuildsReason()
    {
        ManifestedAt(Commit("{\"output\": \"Other\"}", "other"));

        var skipped = Assert.Single((await Restore()).Refused);

        Assert.Equal(
            (RestoreRefusal.NotBuilt, BuildRefusal.OutputNotThisMod,
                $"'{ModName}' was not built: its build configuration names the output folder 'Other', not its folder 'Mod'."),
            (skipped.Refusal.Kind, skipped.Refusal.Build, skipped.Message));
    }

    [Fact]
    public async Task ARestoreCancelledWhileItClonesASource_StopsTheClone_AndSkipsTheMod()
    {
        ManifestedAt(_first);
        using var cancelling = new CancellationTokenSource();
        var notifications = new InMemoryNotificationPublisher { OnPublish = _ => cancelling.Cancel() };

        var skipped = Assert.Single((await Restore(notifications, cancelling.Token)).Refused);

        Assert.Equal($"'{ModName}' was skipped: its source could not be cloned or read: the clone was cancelled.", skipped.Message);
        Assert.False(Directory.Exists(SourceFolder));
    }

    [Fact]
    public async Task AnArchiveItsBuildDidNotPack_LeavesTheModNotFinished_NamingIt()
    {
        ManifestedAt(Commit("{\"output\": \"Mod\", \"archives\": {\"Mod - Main.ba2\": [\"meshes/c.nif\"]}}", "packed"));

        var unfinished = Assert.Single((await Restore()).Refused);

        Assert.Equal(
            (RestoreRefusal.NotFinished, $"'{ModName}' was not finished: 'Mod - Main.ba2' was not packed: Modbench packs no archive for this game."),
            (unfinished.Refusal.Kind, unfinished.Message));
    }

    [Fact]
    public async Task TheRebuild_KeepsTheVersionItsManifestNames()
    {
        ManifestedAt(_first, version: "1.2.3");

        await Restore();

        Assert.Equal("1.2.3", _folders.ReadManifest(ModFolder, ModName)?.Version);
    }

    private void ManifestedAt(string commit, string? remote = null, string? version = null) =>
        _folders.WriteManifest(
            ModFolder, ModName, new Manifest([], [], [new ManifestFile("meshes/c.nif", new FileProvider.Source(remote ?? RemoteFolder, commit))], version));

    private Task<SelectionResult<string, RestoreSkip, RestoredMod>> Restore() => Restore(new InMemoryNotificationPublisher(), CancellationToken.None);

    private Task<SelectionResult<string, RestoreSkip, RestoredMod>> Restore(InMemoryNotificationPublisher notifications, CancellationToken cancel) =>
        TestEditService.RestoreHandler(_holder, notifications, TestAdapters.Source(), _folders).RestoreAsync(
            [new ModToRestore(ModName, ModFolder, [], ["meta.ini"], SourceFolder)],
            new InstanceToRestore([], Path.Combine(_root, "game"), Path.Combine(_root, "stat-cache"), ".mohidden", Archives: null), cancel: cancel);

    private string Commit(string configuration, string mesh)
    {
        File.WriteAllText(Path.Combine(RemoteFolder, "build.json"), configuration);
        Directory.CreateDirectory(Path.Combine(RemoteFolder, "assets", "meshes"));
        File.WriteAllText(Path.Combine(RemoteFolder, "assets", "meshes", "c.nif"), mesh);
        Git(RemoteFolder, "add", "-A");
        Git(RemoteFolder, "commit", "-q", "-m", mesh);
        return Git(RemoteFolder, "rev-parse", "HEAD").Trim();
    }

    private static string Git(string folder, params string[] args) => GitProbe.Run(Path.Combine(folder, ".git"), folder, args);
}
