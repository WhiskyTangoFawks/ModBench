using System.Text.Json;
using MEditService.Core.Edits;
using MEditService.Core.Plugins;
using MEditService.Core.Records;
using MEditService.Core.Schema;
using MEditService.Core.Source;
using Microsoft.Extensions.Logging.Abstractions;
using Mutagen.Bethesda;
using Mutagen.Bethesda.Fallout4;
using Mutagen.Bethesda.Plugins;

namespace MEditService.Tests.Edits;

/// <summary>
/// #643's other unwritable-residue category beside primitive-element lists
/// (<see cref="NestedScalarListSubFieldRefusalTests"/>): nested condition data.
/// <c>ConditionData</c> is abstract and named in
/// <c>SchemaReflector.AbstractUnionExcludedTypeNames</c>, so its sub-schema exposes no
/// <c>concrete_type</c> discriminator and no payload can ever carry the one thing
/// <c>ApplyStructJson</c> would need — <c>BuildStructSubField</c> keeps it on #642's honest
/// refusal instead of wiring a delegate that could never succeed.
///
/// <para>The seam is genuinely reachable, not just theoretical: the enclosing <c>Condition</c>
/// element is itself abstract, but <c>ResolveAbstractUnionConcreteType</c> resolves any
/// <c>concrete_type</c> the <i>payload</i> names regardless of what the read schema exposes, so an
/// element sent as <c>ConditionFloat</c> constructs fine and its own <c>data</c> member is what
/// refuses. CTDA condition data is among the most commonly edited things in an xEdit workflow — a
/// regression here to silent discard is exactly the field class this ticket family exists to
/// protect, hence its own pin.</para>
/// </summary>
public sealed class NestedConditionDataRefusalTests : IDisposable
{
    private readonly MessageFixture _fixture = new();

    public void Dispose() => _fixture.Dispose();

    private static JsonElement Json(string raw) => JsonDocument.Parse(raw).RootElement;

    /// <summary>
    /// Naming <c>data</c> anywhere in the nested tree refuses the whole write and leaves the
    /// working tree byte-identical — including the writable members of the same payload, since a
    /// complex field's write is atomic. The value sent for <c>data</c> is irrelevant by design:
    /// the refusal fires on targeting, before any member value is examined.
    /// </summary>
    [Fact]
    public void MenuButtons_ElementNamingConditionData_RefusesTheWholeWrite()
    {
        var before = _fixture.Body();

        var result = _fixture.Service().EditField(_fixture.Plugin, _fixture.Message.ToString(), "menu_buttons",
            Json("""
            [{"text": "Changed", "conditions": [{"concrete_type": "ConditionFloat", "data": {}}]}]
            """));

        Assert.False(result.Applied);
        Assert.Equal(RecordEditRefusal.NestedFieldReadOnly, result.Refusal);
        Assert.Contains("menu_buttons", result.Message, StringComparison.Ordinal);
        Assert.Equal(before, _fixture.Body());
    }

    /// <summary>Absence is not targeting: the same element write with <c>conditions</c> omitted
    /// entirely still applies, and the named value lands — mirroring
    /// <see cref="NestedScalarListSubFieldRefusalTests.Subgraphs_ElementOmittingAnimationPaths_StillApplies"/>.</summary>
    [Fact]
    public void MenuButtons_ElementOmittingConditions_StillApplies()
    {
        var result = _fixture.Service().EditField(_fixture.Plugin, _fixture.Message.ToString(), "menu_buttons",
            Json("""[{"text": "Changed"}]"""));

        Assert.True(result.Applied, result.Message);
        // A TranslatedString serializes as {"TargetLanguage": ..., "Value": ...} in the document.
        Assert.Contains("\"Value\": \"Changed\"", _fixture.Body(), StringComparison.Ordinal);
    }

    /// <summary>One real mod folder holding one <c>Message</c> with one menu button, tracked once —
    /// the established self-contained-fixture-per-file convention. <c>mesg.menu_buttons</c> is the
    /// cheapest of the 24 enumerated <c>conditions[].data</c> paths to stand up: an ordinary
    /// non-container record whose element type (<c>MessageButton</c>) is concrete, so the write
    /// reaches the condition element without any other abstract resolution in the way.</summary>
    private sealed class MessageFixture : IDisposable
    {
        private const string PluginName = "Message643.esp";
        private const string Origin = "Message643Mod";

        private readonly string _modFolder = Directory.CreateTempSubdirectory("medit-643-mesg-mod-").FullName;
        private readonly string _gameDirectory = Directory.CreateTempSubdirectory("medit-643-mesg-game-").FullName;
        private readonly LoadOrderMirror _mirror;

        public PluginKey Plugin { get; } = new(PluginName, Origin);
        public FormKey Message { get; }

        public MessageFixture()
        {
            var pluginPath = Path.Combine(_modFolder, PluginName);
            var mod = new Fallout4Mod(ModKey.FromFileName(PluginName), Fallout4Release.Fallout4);

            var message = mod.Messages.AddNew("Message643");
            message.Description = "Description643";
            message.MenuButtons.Add(new MessageButton { Text = "Original" });
            Message = message.FormKey;

            mod.WriteToBinary(pluginPath);

            _mirror = new LoadOrderMirror(
                new DuckDbRecordIndexFactory(SharedSchemaReflector.Instance, new TableDdlBuilder(SharedSchemaReflector.Instance)));
            ((ILoadOrderMirror)_mirror).Reconcile(
                _gameDirectory, [new LoadOrderEntry(PluginName, pluginPath, Origin, Slot: 0, Enabled: true, Winning: true)],
                GameRelease.Fallout4);
            new TrackService(NullLogger<TrackService>.Instance)
                .TrackAsync(_mirror.LoadOrder!, Origin, SourcePreset.Edits)
                .GetAwaiter().GetResult();
        }

        public RecordEditService Service() =>
            new(_mirror, SharedSchemaReflector.Instance, NullLogger<RecordEditService>.Instance);

        public string Body() => _mirror.Index!.At(RecordRef.Effective).GetDocument(Message.ToString(), Plugin)!.Body!;

        public void Dispose()
        {
            _mirror.Dispose();
            TryDelete(_modFolder);
            TryDelete(_gameDirectory);
        }

        private static void TryDelete(string path)
        {
            try { Directory.Delete(path, recursive: true); }
            catch (IOException) { /* scratch directory, best effort */ }
            catch (UnauthorizedAccessException) { /* ditto */ }
        }
    }
}
