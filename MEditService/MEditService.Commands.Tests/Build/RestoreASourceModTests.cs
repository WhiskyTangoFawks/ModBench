using MEditService.Commands.Build;
using MEditService.Commands.Tests.TestSupport;
using MEditService.LoadOrder;
using MEditService.ModFolderAdapter;
using MEditService.SourceAdapter;
using MEditService.TestSupport;
using Mutagen.Bethesda;
using Mutagen.Bethesda.Fallout4;
using Mutagen.Bethesda.Plugins;

namespace MEditService.Commands.Tests.Build;

[Collection(ProcessEnvironmentCollection.Name)]
public sealed class RestoreASourceModTests : IDisposable
{
    private const string ModName = "Mod";

    private readonly ScratchDirectory _root = new("medit-restore-source-mod-");
    private readonly LoadOrderHolder _holder = new();
    private readonly ModFolderRepository _folders = new(TimeProvider.System);
    private readonly PinnedSubmodule _submodule;
    private readonly string _first;
    private readonly string _second;

    public RestoreASourceModTests()
    {
        _submodule = new PinnedSubmodule(_root);
        _first = Commit("{\"output\": \"Mod\"}", "first");
        _second = Commit("{\"output\": \"Mod\"}", "second");
        Directory.CreateDirectory(ModFolder);
        File.WriteAllText(Path.Combine(ModFolder, "meta.ini"), "[General]");
        _holder.Apply(SnapshotPlugins.Snapshot(_root, _root, GameRelease.Fallout4, []));
    }

    public void Dispose()
    {
        _submodule.Dispose();
        _root.Dispose();
    }

    private string ModFolder => Path.Combine(_root, "mods", ModName);

    private string SourceFolder => _submodule.Folder;

    [Fact]
    public async Task AnAbsentSubmodule_IsClonedAndBuiltAtItsPin_NamingEachFileNoLineNames()
    {
        Manifested();
        File.WriteAllText(Path.Combine(ModFolder, "notes.txt"), "mine");

        var restored = Assert.Single((await Restore(_first)).Applied);

        Assert.Equal("first", File.ReadAllText(Path.Combine(ModFolder, "meshes", "c.nif")));
        Assert.Equal(_first, Git(SourceFolder, "rev-parse", "HEAD").Trim());
        Assert.Equal(["meshes/c.nif"], restored.Written);
        Assert.Equal(["notes.txt"], restored.NamedByNoLine);
    }

    [Fact]
    public async Task AFileItsBuildConfigurationExcludes_ComesBackUnderTheExclusionMarkHanded_AndItsLineNamesItSo()
    {
        var excluding = Commit("{\"output\": \"Mod\", \"exclude\": [\"meshes/c.nif\"]}", "excluded");
        Manifested();

        Assert.Single((await Restore(excluding)).Applied);

        Assert.Equal("excluded", File.ReadAllText(Path.Combine(ModFolder, "meshes", "c.nif.excluded")));
        Assert.False(File.Exists(Path.Combine(ModFolder, "meshes", "c.nif")));
        Assert.Equal(["meshes/c.nif.excluded"], _folders.ReadManifest(ModFolder, ModName).Require().Files.Select(file => file.Path));
    }

    [Fact]
    public async Task AManifestNamingASubmodule_WhoseRequestHandsNone_IsNotFound_NamingIt()
    {
        Manifested();

        var skipped = Assert.Single((await Restore(pin: null)).Refused);

        Assert.Equal(
            (RestoreRefusal.NotFound, ModName, "was skipped: its submodule 'Mod' is missing."),
            (skipped.Refusal, skipped.SubmoduleNotFound, skipped.Message));
    }

    [Fact]
    public async Task ASourceModWithNoHost_IsSkipped_SayingSo_AndNothingIsWritten()
    {
        _folders.WriteManifest(ModFolder, ModName, new Manifest(
            new ManifestPackage.SourceRepository(ModName, IsSubmodule: false), [new ManifestFile("meshes/c.nif", new PackageEntry.Held())]));

        var skipped = Assert.Single((await Restore(_first)).Refused);

        Assert.Equal((RestoreRefusal.NoHost, "was skipped: its package has no host."), (skipped.Refusal, skipped.Message));
        Assert.False(Directory.Exists(SourceFolder));
    }

    [Fact]
    public async Task TheRebuild_WritesAManifestNamingTheSubmodule_WithTheVersionItsManifestHeld()
    {
        Manifested(version: "1.2.3");

        await Restore(_first);

        Assert.Equal(
            (new ManifestPackage.SourceRepository(ModName, IsSubmodule: true), "1.2.3"),
            (_folders.ReadManifest(ModFolder, ModName)?.Package, _folders.ReadManifest(ModFolder, ModName)?.Version));
    }

    [Fact]
    public async Task APluginWhoseSourceTheLoadOrderDoesNotKnow_IsCompiledFromTheSubmoduleRestoreCloned()
    {
        var (plugin, pin) = await ManifestedPluginSource();
        var changed = new Fallout4Mod(ModKey.FromFileName("Fixture.esp"), Fallout4Release.Fallout4);
        changed.Doors.AddNew("ChangedOutsideModbench");
        changed.WriteToBinary(plugin);
        _holder.Apply(SnapshotPlugins.Snapshot(_root, _root, GameRelease.Fallout4,
            [new LoadOrderEntry("Fixture.esp", plugin, ModName, 0, Enabled: true, Winning: true, NamedProvider: new PluginProvider.FromMod(ModName, ModFolder, null))]));

        Assert.Single((await Restore(pin)).Applied);

        using var restored = Fallout4Mod.CreateFromBinaryOverlay(new ModPath(ModKey.FromFileName("Fixture.esp"), plugin), Fallout4Release.Fallout4);
        Assert.Equal(["FixtureDoor"], restored.Doors.Select(door => door.EditorID));
    }

    private async Task<(string Plugin, string Pin)> ManifestedPluginSource()
    {
        var remote = Path.Combine(_root, "plugin-remote");
        var plugin = Path.Combine(ModFolder, "Fixture.esp");
        var written = new Fallout4Mod(ModKey.FromFileName("Fixture.esp"), Fallout4Release.Fallout4);
        written.Doors.AddNew("FixtureDoor");
        written.WriteToBinary(plugin);
        _holder.Apply(SnapshotPlugins.Snapshot(_root, _root, GameRelease.Fallout4,
            [new LoadOrderEntry("Fixture.esp", plugin, ModName, 0, Enabled: true, Winning: true, NamedProvider: new PluginProvider.FromMod(ModName, ModFolder, remote))]));
        Assert.Single((await TestEditService.DecompileAndCommitModHandler(_holder).DecompileAndCommitAsync([new ModToDecompileAndCommit(ModName, remote, [])])).Value().Applied);
        Git(_submodule.Instance, "config", "-f", ".gitmodules", "submodule.Mod.url", remote);
        _folders.WriteManifest(ModFolder, ModName, new Manifest(
            new ManifestPackage.SourceRepository(ModName, IsSubmodule: true), [new ManifestFile("Fixture.esp", new PackageEntry.Held())]));
        return (plugin, Git(remote, "rev-parse", "HEAD").Trim());
    }

    [Fact]
    public async Task ASubmoduleAtThePinWhoseWorkingTreeHoldsChangesNoCommitHolds_IsBuilt_AndSaysSo()
    {
        Assert.Equal(_first, CommitAtHead(_first));
        File.WriteAllText(Path.Combine(SourceFolder, "assets", "meshes", "c.nif"), "changed");
        Manifested();

        var restored = Assert.Single((await Restore(_first)).Applied);

        Assert.True(restored.Uncommitted);
        Assert.Equal("changed", File.ReadAllText(Path.Combine(ModFolder, "meshes", "c.nif")));
    }

    [Fact]
    public async Task ASubmoduleClonedIntoAGitDirectoryWhoseBranchIsElsewhere_LandsNamingWhyItIsLeftDetached()
    {
        Assert.Equal(_second, CommitAtHead(_second));
        Git(SourceFolder, "checkout", "-q", "main");
        Git(SourceFolder, "commit", "-q", "--allow-empty", "-m", "unpushed");
        Git(_submodule.Instance, "submodule", "deinit", "-q", "-f", "--", "source/Mod");
        Manifested();

        var restored = Assert.Single((await Restore(_second, branch: "main")).Applied);

        Assert.StartsWith("its branch 'main' is at ", restored.LeftDetached, StringComparison.Ordinal);
    }

    [Fact]
    public async Task ASubmoduleAtAnotherCommit_IsSkippedNamingTheCommit_AndNothingIsWritten()
    {
        Assert.Equal(_second, CommitAtHead(_second));
        Manifested();

        var skipped = Assert.Single((await Restore(_first)).Refused);

        Assert.Equal(
            (RestoreRefusal.SourceAtAnotherCommit, $"was skipped: its submodule is at {_second}, not at {_first}, the commit the instance repository pins."),
            (skipped.Refusal, skipped.Message));
        Assert.False(File.Exists(Path.Combine(ModFolder, "meshes", "c.nif")));
    }

    [Fact]
    public async Task APinItsRemoteDoesNotHold_IsSkippedNamingThePin()
    {
        const string Unpushed = "0123456789012345678901234567890123456789";
        Manifested();

        var skipped = Assert.Single((await Restore(Unpushed)).Refused);

        Assert.Equal(
            (RestoreRefusal.SourceUnavailable, $"was skipped: its submodule could not be cloned or read: its remote holds no commit {Unpushed}."),
            (skipped.Refusal, skipped.Message));
    }

    [Fact]
    public async Task ASubmoduleWhoseBuildRefusesTheMod_IsSkippedWithTheBuildsReason()
    {
        var other = Commit("{\"output\": \"Other\"}", "other");
        Manifested();

        var skipped = Assert.Single((await Restore(other)).Refused);

        Assert.Equal(
            (RestoreRefusal.NotBuilt, BuildRefusal.OutputNotThisMod,
                "was not built: its build configuration names the output folder 'Other', not its folder 'Mod'."),
            (skipped.Refusal, skipped.BuildRefusal, skipped.Message));
    }

    [Fact]
    public async Task ASubmoduleWhosePluginsCannotCompile_AsGitCannotRun_IsNotBuilt_NamingWhy_AndNothingIsWritten()
    {
        Manifested();

        var skipped = Assert.Single((await Restore(_first, source: new GitGoneSourceAdapter())).Refused);

        Assert.Equal((RestoreRefusal.NotBuilt, BuildRefusal.GitUnavailable), (skipped.Refusal, skipped.BuildRefusal));
        Assert.StartsWith("was not built: ", skipped.Message, StringComparison.Ordinal);
        Assert.Contains("PATH", skipped.Message, StringComparison.Ordinal);
        Assert.False(File.Exists(Path.Combine(ModFolder, "meshes", "c.nif")));
    }

    [Fact]
    public async Task ARestoreCancelledWhileItClonesASubmodule_StopsTheClone_AndSkipsTheMod()
    {
        Manifested();
        using var cancelling = new CancellationTokenSource();
        var notifications = new InMemoryNotificationPublisher { OnPublish = _ => cancelling.Cancel() };

        var skipped = Assert.Single((await Restore(_first, notifications, cancelling.Token)).Refused);

        Assert.Equal("was skipped: its submodule could not be cloned or read: the clone was cancelled.", skipped.Message);
        Assert.False(Directory.Exists(SourceFolder) && Directory.EnumerateFileSystemEntries(SourceFolder).Any());
    }

    [Fact]
    public async Task AnArchiveItsBuildDidNotPack_LeavesTheModNotFinished_NamingIt()
    {
        var packed = Commit("{\"output\": \"Mod\", \"archives\": {\"Mod - Main.ba2\": [\"meshes/c.nif\"]}}", "packed");
        Manifested();

        var unfinished = Assert.Single((await Restore(packed)).Refused);

        Assert.Equal(
            (RestoreRefusal.NotFinished, $"was not finished: 'Mod - Main.ba2' was not packed: Modbench packs no archive for this game."),
            (unfinished.Refusal, unfinished.Message));
    }

    private void Manifested(string? version = null) =>
        _folders.WriteManifest(ModFolder, ModName, new Manifest(
            new ManifestPackage.SourceRepository(ModName, IsSubmodule: true), [new ManifestFile("meshes/c.nif", new PackageEntry.Held())], version));

    private string CommitAtHead(string pin)
    {
        _submodule.Pin(pin);
        return TestAdapters.Source().CommitAtHead(new Submodule(SourceFolder, pin, null), CancellationToken.None).Value().Commit;
    }

    private Task<RestoreFromManifestResult> Restore(string? pin, string? branch = null, ISourceAdapter? source = null) =>
        Restore(pin, new InMemoryNotificationPublisher(), CancellationToken.None, branch, source);

    private Task<RestoreFromManifestResult> Restore(
        string? pin, InMemoryNotificationPublisher notifications, CancellationToken cancel, string? branch = null, ISourceAdapter? source = null)
    {
        if (pin is not null) _submodule.Pin(pin);
        return TestEditService.RestoreHandler(_holder, notifications, source ?? TestAdapters.Source(), _folders).RestoreAsync(
            [new ModToRestore(ModName, ModFolder, null, ["meta.ini"], pin is null ? null : new Submodule(SourceFolder, pin, branch), UnreadableGameFiles: null, UnreadableInstallationFile: null)],
            new InstanceToRestore(Path.Combine(_root, "stat-cache"), ".excluded", Archives: null, GameFolder: null), "restore", cancel);
    }

    private string Commit(string configuration, string mesh) =>
        _submodule.Commit(("build.json", configuration), ("assets/meshes/c.nif", mesh));

    private static string Git(string folder, params string[] args) => PinnedSubmodule.Git(folder, args);
}
