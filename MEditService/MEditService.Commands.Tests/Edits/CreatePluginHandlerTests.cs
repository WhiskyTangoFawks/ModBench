using MEditService.Commands;
using MEditService.Commands.Edits;
using MEditService.Commands.Tests.TestSupport;
using MEditService.LoadOrder;
using MEditService.SourceAdapter;
using MEditService.TestSupport;
using Mutagen.Bethesda;
using Mutagen.Bethesda.Plugins;
using Mutagen.Bethesda.Plugins.Records;

namespace MEditService.Commands.Tests.Edits;

// ADR-0007: the destination is a caller-resolved (path, origin), a mod folder or overwrite/, never
// implicitly Data, and the gesture never touches plugins.txt: that append is the caller's job.
public sealed class CreatePluginHandlerTests : IDisposable
{
    private readonly PluginFixtureData _data = new PluginFixtureBuilder("create-plugin-handler")
        .WithPlugin("Base.esp")
        .Build();

    private readonly LoadOrderHolder _holder = new();

    public CreatePluginHandlerTests() =>
        _holder.Apply(new LoadOrderSnapshot(_data.DataFolder, _data.InstanceRoot, GameRelease.Fallout4, SnapshotPlugins.Of(_data.Plugins)));

    public void Dispose() => _data.Dispose();

    private CreatePluginHandler Handler => TestEditService.PluginCreateHandler(_holder);

    private string ModFolder(string name) => Path.Combine(_data.DataFolder, name);

    private Task<PluginCreateResult> Create(string name, string modFolder, string origin) =>
        Handler.CreatePlugin(name, Path.Combine(modFolder, name), origin);

    [Fact]
    public async Task CreatePlugin_WritesTheFileAtThePluginsPath()
    {
        var modFolder = ModFolder("StateMod");

        var result = await Create("NewPlugin.esp", modFolder, "StateMod");

        Assert.True(result.Applied);
        Assert.Equal(Path.Combine(modFolder, "NewPlugin.esp"), result.Plugin.Path);
        Assert.True(File.Exists(result.Plugin.Path));
    }

    // A created plugin reaches every reader through this one snapshot change; a plugin the
    // reconcile cannot open is not a row, so the file comes first.
    [Fact]
    public async Task CreatePlugin_RegistersThePlugin_OnlyOnceItsFileExists()
    {
        var existedWhenApplied = new List<bool>();
        _holder.Changed += (snapshot, _) =>
            existedWhenApplied.Add(snapshot.Plugins.Where(c => c.Name == "Announced.esp").All(c => File.Exists(c.Path)));

        var result = await Create("Announced.esp", ModFolder("AnnouncedMod"), "AnnouncedMod");

        Assert.NotNull(_holder.Current.Plugin(result.Plugin.Key));
        Assert.Equal([true], existedWhenApplied);
        Assert.Equal(_holder.Version, result.Version);
    }

    // One past the highest slot, not the count: a reused slot would give two participants one index.
    [Fact]
    public async Task CreatePlugin_TakesTheSlotPastTheHighestRegisteredOne()
    {
        var highest = _holder.Current.Plugins.Max(c => c.Slot ?? 0);

        var result = await Create("Slotted.esp", ModFolder("SlottedMod"), "SlottedMod");

        Assert.Equal(highest + 1, result.Plugin.Slot);
        Assert.True(result.Plugin.Enabled);
        Assert.True(result.Plugin.Winning);
    }

    // No file was created, so nothing is registered: the load order every reader holds is the one
    // this gesture found.
    [Fact]
    public async Task CreatePlugin_WhoseWriteFails_LeavesTheLoadOrderAsItWas()
    {
        var modFolder = ModFolder("OccupiedMod");
        Directory.CreateDirectory(modFolder);
        File.WriteAllText(Path.Combine(modFolder, "Occupied.esp"), "not a plugin");
        var before = _holder.Current;

        await Assert.ThrowsAsync<IOException>(() => Create("Occupied.esp", modFolder, "OccupiedMod"));

        Assert.Same(before, _holder.Current);
    }

    // Track refuses when nothing readable carries the origin; the file is residue, but the load
    // order every reader holds is the one this gesture found.
    [Fact]
    public async Task CreatePlugin_WhoseTrackRefuses_LeavesTheLoadOrderAsItWas()
    {
        var modFolder = ModFolder("RefusedMod");
        var handler = TestEditService.PluginCreateHandler(_holder, new UnreadableAfterWriteAdapter("Refused.esp"));
        var before = _holder.Current;

        var result = await handler.CreatePlugin("Refused.esp", Path.Combine(modFolder, "Refused.esp"), "RefusedMod");

        Assert.False(result.Applied);
        Assert.Equal(TrackRefusal.RoundTripFailed, result.Track.Require().Refusal);
        Assert.Same(before, _holder.Current);
        Assert.Null(_holder.Current.Plugin(result.Plugin.Key));
    }

    [Fact]
    public async Task CreatePlugin_WithNoLoadOrderHeld_RefusesBeforeWritingAnything()
    {
        var modFolder = ModFolder("HomelessMod");
        var handler = TestEditService.PluginCreateHandler(new LoadOrderHolder());

        await Assert.ThrowsAsync<NoLoadOrderException>(
            () => handler.CreatePlugin("Homeless.esp", Path.Combine(modFolder, "Homeless.esp"), "HomelessMod"));

        Assert.False(File.Exists(Path.Combine(modFolder, "Homeless.esp")));
    }

    // A newly created plugin defaults to an ESL-flagged ESP silently, the flag being an ordinary
    // editable header field afterward. Asserted at the binary, where the game reads it.
    [Fact]
    public async Task CreatePlugin_DefaultsToAnEslFlaggedEsp()
    {
        var modFolder = ModFolder("EslMod");

        await Create("NewPlugin.esp", modFolder, "EslMod");

        Assert.True(Written(modFolder, "NewPlugin.esp").IsSmallMaster);
    }

    // An explicit .esm asked for a full master, so the silent ESL flag is for .esp alone.
    [Fact]
    public async Task CreatePlugin_EsmExtension_IsAcceptedAndNotEslFlagged()
    {
        var modFolder = ModFolder("EsmMod");

        await Create("NewMaster.esm", modFolder, "EsmMod");

        Assert.False(Written(modFolder, "NewMaster.esm").IsSmallMaster);
    }

    // An explicit .esl is already light by its extension, so nothing sets the flag for it either.
    [Fact]
    public async Task CreatePlugin_EslExtension_IsAcceptedAndNotEslFlagged()
    {
        var modFolder = ModFolder("LightMod");

        await Create("NewLight.esl", modFolder, "LightMod");

        Assert.False(Written(modFolder, "NewLight.esl").IsSmallMaster);
    }

    // plugins.txt is Mod Management's file, and appending the load-order line is the caller's job,
    // done only once the whole create has succeeded.
    [Fact]
    public async Task CreatePlugin_NeverWritesPluginsTxt()
    {
        await Create("NewPlugin.esp", ModFolder("QuietMod"), "QuietMod");

        Assert.Empty(Directory.EnumerateFiles(_data.CleanupRoot, "Plugins.txt", SearchOption.AllDirectories));
    }

    [Fact]
    public async Task CreatePlugin_DestinationFolderDoesNotExistYet_CreatesIt()
    {
        var modFolder = ModFolder("BrandNewMod");
        Assert.False(Directory.Exists(modFolder));

        await Create("New.esp", modFolder, "BrandNewMod");

        Assert.True(File.Exists(Path.Combine(modFolder, "New.esp")));
    }

    // Editing requires tracking (ADR-0007), so an untracked destination is tracked in this same
    // gesture rather than left for a second one.
    [Fact]
    public async Task CreatePlugin_UntrackedDestination_TracksIt()
    {
        var modFolder = ModFolder("TrackMeMod");

        var result = await Create("Tracked.esp", modFolder, "TrackMeMod");

        Assert.True(result.Applied);
        Assert.True(SourceRepository.IsTracked(modFolder));
        Assert.True(result.Track.Require().Applied);
    }

    // The rival is Track's own refusal to re-track: a create that always tracks would refuse the
    // second plugin into a folder its own first plugin tracked.
    [Fact]
    public async Task CreatePlugin_AlreadyTrackedDestination_DoesNotTrackAgain()
    {
        var modFolder = ModFolder("TwiceMod");
        await Create("First.esp", modFolder, "TwiceMod");
        var commitsBefore = Commits(modFolder);

        var second = await Create("Second.esp", modFolder, "TwiceMod");

        Assert.True(second.Applied);
        Assert.Null(second.Track);
        Assert.Equal(commitsBefore, Commits(modFolder));
    }

    // Modbench's own write is never an external change (ADR-0003): the created binary is parked as
    // this gesture's, so the mod's next settle finds nothing to ask about.
    [Fact]
    public async Task CreatePlugin_IntoATrackedDestination_LeavesNoExternalChangeQuestionToRaise()
    {
        var modFolder = ModFolder("SettledMod");
        await Create("First.esp", modFolder, "SettledMod");
        await Create("Second.esp", modFolder, "SettledMod");
        var notifications = new InMemoryNotificationPublisher();

        var outcome = TestEditService.Settled(notifications).Handle(_holder.Current, modFolder);

        Assert.Equal(TrackedModSettledOutcome.NoQuestion, outcome);
        Assert.Empty(notifications.Notifications);
    }

    [Fact]
    public async Task CreatePlugin_AlreadyExists_ThrowsIOException()
    {
        var modFolder = ModFolder("DupMod");
        await Create("Duplicate.esp", modFolder, "DupMod");

        var ex = await Assert.ThrowsAsync<IOException>(() => Create("Duplicate.esp", modFolder, "DupMod"));

        Assert.Contains("already exists", ex.Message, StringComparison.Ordinal);
    }

    // The real adapter, except that the file it just wrote cannot be read back: what another tool
    // holding the new file against a reader looks like to Track.
    private sealed class UnreadableAfterWriteAdapter(string name) : ReadOnlyPluginAdapter
    {
        public override bool CanRead(ModPath modPath) =>
            !modPath.ModKey.FileName.String.Equals(name, StringComparison.OrdinalIgnoreCase) && base.CanRead(modPath);

        public override Task CreateAndWriteAsync(ModKey modKey, string destinationPath, GameRelease gameRelease, bool smallMaster) =>
            TestAdapters.Mutagen().CreateAndWriteAsync(modKey, destinationPath, gameRelease, smallMaster);
    }

    private static IModFlagsGetter Written(string modFolder, string name) =>
        (IModFlagsGetter)ModFactory.ImportGetter(
            new ModPath(ModKey.FromFileName(name), Path.Combine(modFolder, name)), GameRelease.Fallout4);

    private static string Commits(string modFolder) =>
        GitProbe.Run(Path.Combine(modFolder, ".git"), modFolder, "rev-list", "--count", "main");
}
