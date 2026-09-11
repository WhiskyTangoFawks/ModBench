using MEditService.Api.Endpoints;
using MEditService.Core.Plugins;
using MEditService.Tests.TestSupport;
using Microsoft.AspNetCore.Http;
using Microsoft.AspNetCore.Http.HttpResults;
using Microsoft.Extensions.Logging.Abstractions;
using Mutagen.Bethesda;

namespace MEditService.Tests.Api;

/// <summary>The create endpoint is the holder's second writer (ADR-0044): it builds the copy,
/// composes it into the current value and applies that before the handler runs.</summary>
public sealed class CreatePluginEndpointTests : IDisposable
{
    private readonly IndexedModFixture _mod = IndexedModFixture.Tracked();

    public void Dispose() => _mod.Dispose();

    private Task<IResult> Create(string name, string origin, LoadOrderHolder? holder = null) =>
        Create(name, _mod.ModFolder, origin, holder);

    private Task<IResult> Create(string name, string path, string origin, LoadOrderHolder? holder = null) =>
        PluginEndpoints.CreatePlugin(
            new CreatePluginRequest(name, path, origin),
            _mod.Index, holder ?? _mod.Holder,
            TestEditService.PluginCreateHandler(holder ?? _mod.Holder), NullLoggerFactory.Instance);

    private RegisteredCopy? Registered(string name, string origin) =>
        _mod.Holder.Current.Copy(new PluginKey(name, origin));

    // ADR-0041: a created plugin is a registered copy at once, so the Track that follows it in the
    // same gesture, and every later reader, find it without waiting for the next snapshot.
    [Fact]
    public async Task CreatePlugin_RegistersTheCopyInTheSharedKernel()
    {
        var result = await Create("Minted.esp", IndexedModFixture.ModFolderOrigin);

        Assert.IsAssignableFrom<Ok<PluginCreatedResponse>>(result);
        var registered = Registered("Minted.esp", IndexedModFixture.ModFolderOrigin);
        Assert.NotNull(registered);
        Assert.Equal(Path.Combine(_mod.ModFolder, "Minted.esp"), registered.Path);
    }

    // One past the highest slot the value carries; a reused one would give two participants a
    // single index.
    [Fact]
    public async Task CreatePlugin_TakesTheSlotPastTheHighestRegisteredOne()
    {
        var highest = _mod.Holder.Current.Copies.Max(copy => copy.Slot ?? 0);

        var result = await Create("Slotted.esp", IndexedModFixture.ModFolderOrigin);

        var ok = Assert.IsAssignableFrom<Ok<PluginCreatedResponse>>(result);
        Assert.Equal(highest + 1, ok.Value!.Slot);
        Assert.Equal(highest + 1, Registered("Slotted.esp", IndexedModFixture.ModFolderOrigin)!.Slot);
    }

    [Fact]
    public async Task CreatePlugin_NoLoadOrder_Answers503()
    {
        var empty = new LoadOrderHolder();

        var result = await Create("Homeless.esp", IndexedModFixture.ModFolderOrigin, empty);

        Assert.Equal(503, Assert.IsAssignableFrom<ProblemHttpResult>(result).StatusCode);
        Assert.Empty(empty.Current.Copies);
    }

    // Refused before the holder is written: a name that could never be a plugin registers nothing.
    [Fact]
    public async Task CreatePlugin_InvalidExtension_Answers400_AndRegistersNothing()
    {
        var result = await Create("Mod.txt", IndexedModFixture.ModFolderOrigin);

        var problem = Assert.IsAssignableFrom<ProblemHttpResult>(result);
        Assert.Equal(400, problem.StatusCode);
        Assert.Contains("extension", problem.ProblemDetails.Detail!, StringComparison.Ordinal);
        Assert.Null(Registered("Mod.txt", IndexedModFixture.ModFolderOrigin));
    }

    [Theory]
    [InlineData("", "/tmp/SomeMod", "SomeMod")]
    [InlineData("   ", "/tmp/SomeMod", "SomeMod")]
    [InlineData("New.esp", "   ", "SomeMod")]
    [InlineData("New.esp", "/tmp/SomeMod", "   ")]
    public async Task CreatePlugin_EmptyArgument_Answers400(string name, string path, string origin)
    {
        var result = await Create(name, path, origin);

        Assert.Equal(400, Assert.IsAssignableFrom<ProblemHttpResult>(result).StatusCode);
    }

    // The registration precedes the file, so a create that cannot write its file leaves a copy the
    // load order should never have carried: the endpoint takes it back.
    [Fact]
    public async Task CreatePlugin_WhenTheFileCannotBeCreated_RevertsTheRegistration()
    {
        await File.WriteAllTextAsync(Path.Combine(_mod.ModFolder, "Occupied.esp"), "not a plugin");
        var before = _mod.Holder.Current;

        var result = await Create("Occupied.esp", IndexedModFixture.ModFolderOrigin);

        Assert.Equal(409, Assert.IsAssignableFrom<ProblemHttpResult>(result).StatusCode);
        Assert.Null(Registered("Occupied.esp", IndexedModFixture.ModFolderOrigin));
        Assert.Equal(before, _mod.Holder.Current);
    }

    // Mutagen refuses a filename the extension check passes, which is the one argument refusal that
    // can reach the holder write.
    [Fact]
    public async Task CreatePlugin_WhenMutagenRefusesTheFilename_Answers400_AndRevertsTheRegistration()
    {
        var before = _mod.Holder.Current;

        var result = await Create("Bad|Name.esp", IndexedModFixture.ModFolderOrigin);

        Assert.Equal(400, Assert.IsAssignableFrom<ProblemHttpResult>(result).StatusCode);
        Assert.Null(Registered("Bad|Name.esp", IndexedModFixture.ModFolderOrigin));
        Assert.Equal(before, _mod.Holder.Current);
    }

    // The second create registers over the first, so its revert must put the first back rather than
    // drop the identity outright.
    [Fact]
    public async Task CreatePlugin_ASecondTimeAtOneDestination_LeavesTheFirstRegistrationIntact()
    {
        Assert.IsAssignableFrom<Ok<PluginCreatedResponse>>(await Create("Twice.esp", IndexedModFixture.ModFolderOrigin));
        var first = Registered("Twice.esp", IndexedModFixture.ModFolderOrigin);

        var second = await Create("Twice.esp", IndexedModFixture.ModFolderOrigin);

        Assert.Equal(409, Assert.IsAssignableFrom<ProblemHttpResult>(second).StatusCode);
        Assert.Equal(first, Registered("Twice.esp", IndexedModFixture.ModFolderOrigin));
    }

    // The kernel can move on while the file is being written, so the revert takes back its own copy
    // rather than restoring the value it read: the snapshot that landed meanwhile survives.
    [Fact]
    public void ARevertedCreate_KeepsASnapshotThatLandedWhileItWasWriting()
    {
        var previous = Order(Copy("A.esp"));
        var minted = Copy("Minted.esp");
        var landedDuringTheWrite = Order(Copy("A.esp"), Copy("B.esp")).With(minted);

        var reverted = PluginEndpoints.Unregistered(landedDuringTheWrite, previous, minted.Key);

        Assert.Equal(["A.esp", "B.esp"], reverted.Copies.Select(copy => copy.Name).Order(StringComparer.Ordinal));
    }

    // ADR-0041: the endpoint's registration is what makes a created plugin editable at once — the
    // edit side resolves its write target from the kernel, asking the Index nothing.
    [Fact]
    public async Task AnEditAfterCreate_ResolvesToTheNewCopy()
    {
        Assert.IsAssignableFrom<Ok<PluginCreatedResponse>>(
            await Create("Editable.esp", IndexedModFixture.ModFolderOrigin));

        var edit = TestEditService.CreateHandler(_mod.Holder).CreateRecord(
            new PluginKey("Editable.esp", IndexedModFixture.ModFolderOrigin), "npc_", "MintedNpc");

        Assert.True(edit.Applied);
        Assert.EndsWith("Editable.esp", edit.NewFormKey!, StringComparison.OrdinalIgnoreCase);
    }

    private LoadOrder Order(params RegisteredCopy[] copies) =>
        new(_mod.GameDirectory, _mod.InstanceRoot, GameRelease.Fallout4, copies);

    private RegisteredCopy Copy(string name) =>
        new(name, IndexedModFixture.ModFolderOrigin, Path.Combine(_mod.ModFolder, name), 0, Enabled: true, Winning: true);
}
