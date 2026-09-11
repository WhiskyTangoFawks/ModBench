using MEditService.Api.Endpoints;
using MEditService.Core.Plugins;
using MEditService.Tests.TestSupport;
using Microsoft.AspNetCore.Http;
using Microsoft.AspNetCore.Http.HttpResults;
using Microsoft.Extensions.Logging.Abstractions;

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
    // load order should never have carried: the endpoint puts the previous value back.
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
}
