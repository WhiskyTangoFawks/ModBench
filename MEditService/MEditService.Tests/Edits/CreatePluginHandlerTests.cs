using MEditService.Core.Commands;
using MEditService.Core.Plugins;
using MEditService.Core.Records;
using MEditService.Core.Source;
using MEditService.Tests.TestSupport;
using Mutagen.Bethesda;
using Mutagen.Bethesda.Plugins;
using Mutagen.Bethesda.Plugins.Records;

namespace MEditService.Tests.Edits;

// ADR-0041: the destination is a caller-resolved (path, origin), a mod folder or overwrite/, never
// implicitly Data, and the gesture never touches plugins.txt: that append is the caller's job.
public sealed class CreatePluginHandlerTests : IDisposable
{
    private readonly PluginFixtureData _data = new PluginFixtureBuilder("create-plugin-handler")
        .WithPlugin("Base.esp")
        .Build();

    private readonly LoadOrderHolder _holder = new();

    public CreatePluginHandlerTests() =>
        _holder.Apply(LoadOrder.From(_data.DataFolder, _data.InstanceRoot, GameRelease.Fallout4, _data.Plugins));

    public void Dispose() => _data.Dispose();

    private CreatePluginHandler Handler => TestEditService.PluginCreateHandler(_holder);

    private static CreatePluginHandler Unloaded => TestEditService.PluginCreateHandler(new LoadOrderHolder());

    private string ModFolder(string name) => Path.Combine(_data.DataFolder, name);

    private Task<PluginCreateResult> Create(string name, string path, string origin) =>
        Handler.CreatePlugin(HeldCopies(), name, path, origin);

    // Every fixture copy is held: nothing here fails to open, so Track sees them all.
    private IReadOnlyCollection<PluginKey> HeldCopies() =>
        [.. _holder.Current.Copies.Select(copy => copy.Key)];

    [Fact]
    public async Task CreatePlugin_RegistersTheCopyOnTheLoadOrderHolder()
    {
        var modFolder = ModFolder("StateMod");

        var result = await Create("NewPlugin.esp", modFolder, "StateMod");

        Assert.True(result.Applied);
        Assert.Equal("StateMod", result.Copy.Origin);
        Assert.Equal(Path.Combine(modFolder, "NewPlugin.esp"), result.Copy.Path);
        Assert.NotNull(_holder.Current.Copy(new PluginKey("NewPlugin.esp", "StateMod")));
    }

    // The slot is one past the highest the snapshot carries; a reused one would give two
    // participants a single index.
    [Fact]
    public async Task CreatePlugin_TakesTheSlotPastTheHighestRegisteredOne()
    {
        var highest = _holder.Current.Copies.Max(copy => copy.Slot ?? 0);

        var result = await Create("Slotted.esp", ModFolder("SlottedMod"), "SlottedMod");

        Assert.Equal(highest + 1, result.Copy.Slot);
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

        var result = await Create("NewMaster.esm", modFolder, "EsmMod");

        Assert.Equal("NewMaster.esm", result.Copy.Name);
        Assert.False(Written(modFolder, "NewMaster.esm").IsSmallMaster);
    }

    // An explicit .esl is already light by its extension, so nothing sets the flag for it either.
    [Fact]
    public async Task CreatePlugin_EslExtension_IsAcceptedAndNotEslFlagged()
    {
        var modFolder = ModFolder("LightMod");

        var result = await Create("NewLight.esl", modFolder, "LightMod");

        Assert.Equal("NewLight.esl", result.Copy.Name);
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

    // Editing requires tracking (ADR-0041), so an untracked destination is tracked in this same
    // gesture rather than left for a second one.
    [Fact]
    public async Task CreatePlugin_UntrackedDestination_TracksIt()
    {
        var modFolder = ModFolder("TrackMeMod");

        var result = await Create("Tracked.esp", modFolder, "TrackMeMod");

        Assert.True(result.Applied);
        Assert.True(SourceRepository.IsTracked(modFolder));
        Assert.True(result.Track!.Applied);
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

    [Fact]
    public async Task CreatePlugin_AlreadyExists_ThrowsIOException()
    {
        var modFolder = ModFolder("DupMod");
        await Create("Duplicate.esp", modFolder, "DupMod");

        var ex = await Assert.ThrowsAsync<IOException>(() => Create("Duplicate.esp", modFolder, "DupMod"));

        Assert.Contains("already exists", ex.Message, StringComparison.Ordinal);
    }

    [Fact]
    public async Task CreatePlugin_NoLoadOrder_ThrowsNoLoadOrderException()
    {
        var ex = await Assert.ThrowsAsync<NoLoadOrderException>(
            () => Unloaded.CreatePlugin([], "New.esp", "/tmp/SomeMod", "SomeMod"));

        Assert.Contains("No load order", ex.Message, StringComparison.Ordinal);
    }

    // The extension check fires before the load order is consulted: a name that could never be a
    // plugin is refused whether or not a snapshot has arrived.
    [Fact]
    public async Task CreatePlugin_InvalidExtension_ThrowsArgumentException()
    {
        var ex = await Assert.ThrowsAsync<ArgumentException>(
            () => Unloaded.CreatePlugin([], "Mod.txt", "/tmp/SomeMod", "SomeMod"));

        Assert.Contains("extension", ex.Message, StringComparison.Ordinal);
    }

    [Theory]
    [InlineData(null, "/tmp/SomeMod", "SomeMod")]
    [InlineData("   ", "/tmp/SomeMod", "SomeMod")]
    [InlineData("New.esp", "   ", "SomeMod")]
    [InlineData("New.esp", "/tmp/SomeMod", "   ")]
    public async Task CreatePlugin_EmptyArgument_ThrowsArgumentException(string? name, string path, string origin)
    {
        var ex = await Assert.ThrowsAsync<ArgumentException>(() => Create(name!, path, origin));

        Assert.Contains("empty", ex.Message, StringComparison.Ordinal);
    }

    private static IModFlagsGetter Written(string modFolder, string name) =>
        (IModFlagsGetter)ModFactory.ImportGetter(
            new ModPath(ModKey.FromFileName(name), Path.Combine(modFolder, name)), GameRelease.Fallout4);

    private static string Commits(string modFolder) =>
        GitCli.Run(Path.Combine(modFolder, ".git"), modFolder, "rev-list", "--count", "main");
}
