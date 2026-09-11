using MEditService.Core.Commands;
using MEditService.Core.Plugins;
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
        _holder.Apply(new LoadOrder(_data.DataFolder, _data.InstanceRoot, GameRelease.Fallout4, SnapshotCopies.Of(_data.Plugins)));

    public void Dispose() => _data.Dispose();

    private CreatePluginHandler Handler => TestEditService.PluginCreateHandler(_holder);

    private string ModFolder(string name) => Path.Combine(_data.DataFolder, name);

    // What the create endpoint hands over: the copy already registered, and the load order that
    // registers it.
    private Task<PluginCreateResult> Create(string name, string path, string origin)
    {
        var copy = new RegisteredCopy(name, origin, Path.Combine(path, name), 1, Enabled: true, Winning: true);
        var registered = _holder.Current.With(copy);
        return Handler.CreatePlugin(registered, copy, [.. registered.Copies.Select(c => c.Key)]);
    }

    [Fact]
    public async Task CreatePlugin_WritesTheFileAtTheCopysPath()
    {
        var modFolder = ModFolder("StateMod");

        var result = await Create("NewPlugin.esp", modFolder, "StateMod");

        Assert.True(result.Applied);
        Assert.Equal("StateMod", result.Copy.Origin);
        Assert.Equal(Path.Combine(modFolder, "NewPlugin.esp"), result.Copy.Path);
        Assert.True(File.Exists(Path.Combine(modFolder, "NewPlugin.esp")));
    }

    // The write side writes systems of record, never the kernel: the endpoint registered this copy
    // before the handler ran, and the handler has no holder to write.
    [Fact]
    public async Task CreatePlugin_WritesNothingToTheHolder()
    {
        var before = _holder.Current;

        await Create("Untouched.esp", ModFolder("UntouchedMod"), "UntouchedMod");

        Assert.Same(before, _holder.Current);
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

    // The write API with no Index: a copy registered by the create gesture is an editable write
    // target at once, which is what makes a created plugin editable before any snapshot names it.
    [Fact]
    public async Task AnEditAfterCreate_ResolvesToTheNewCopy()
    {
        var modFolder = ModFolder("EditableMod");
        var copy = new RegisteredCopy(
            "Editable.esp", "EditableMod", Path.Combine(modFolder, "Editable.esp"), 1, Enabled: true, Winning: true);
        _holder.Apply(_holder.Current.With(copy));
        await Handler.CreatePlugin(_holder.Current, copy, [.. _holder.Current.Copies.Select(c => c.Key)]);

        var edit = TestEditService.CreateHandler(_holder).CreateRecord(copy.Key, "npc_", "MintedNpc");

        Assert.True(edit.Applied);
        Assert.EndsWith("Editable.esp", edit.NewFormKey!, StringComparison.OrdinalIgnoreCase);
    }

    private static IModFlagsGetter Written(string modFolder, string name) =>
        (IModFlagsGetter)ModFactory.ImportGetter(
            new ModPath(ModKey.FromFileName(name), Path.Combine(modFolder, name)), GameRelease.Fallout4);

    private static string Commits(string modFolder) =>
        GitCli.Run(Path.Combine(modFolder, ".git"), modFolder, "rev-list", "--count", "main");
}
