using MEditService.Core.Serialization;
using MEditService.Tests.TestSupport;
using Microsoft.Extensions.Logging.Abstractions;
using Mutagen.Bethesda;
using Mutagen.Bethesda.Fallout4;
using Mutagen.Bethesda.Plugins;
using Mutagen.Bethesda.Plugins.Records;

namespace MEditService.Tests.Serialization;

/// <summary>
/// #370 Slice A1: <see cref="RecordTextCodec"/>'s runtime record-type dispatch, proven at the
/// codec's own public seam rather than only through the one or two types an API-level fixture
/// happens to exercise (#367's Weapon-only mechanism generalizes to any of the ~586 generated
/// types via reflection on the generated class name — see RecordTextCodec's own doc comment).
///
/// Two positive types on purpose, not one: Npc (a plain record — the type #370's primary API
/// fixtures actually stage edits against) and Cell (a container-shaped type, built here with no
/// children populated so it stays one file regardless of shallow-vendoring policy — that policy is
/// Slice F's concern, not dispatch's). Proving dispatch against two differently-shaped generated
/// classes is what distinguishes "resolves for the one type someone tried" from "resolves by a
/// naming convention that actually holds".
/// </summary>
public class RecordTypeDispatchTests
{
    private static Npc MakeNpc() =>
        new(new FormKey(ModKey.FromFileName("Test.esp"), 0x900), Fallout4Release.Fallout4)
        {
            EditorID = "TestNpc",
            Name = "Test NPC Name",
        };

    private static Cell MakeCell() =>
        new(new FormKey(ModKey.FromFileName("Test.esp"), 0x901), Fallout4Release.Fallout4)
        {
            EditorID = "TestCell",
        };

    [Fact]
    public async Task SerializeAsync_ThenDeserializeAsync_DispatchesNpcByRuntimeType()
    {
        var codec = new RecordTextCodec(NullLogger<RecordTextCodec>.Instance);
        var original = MakeNpc();
        var dir = Directory.CreateTempSubdirectory("medit-dispatch-npc-");
        try
        {
            var filePath = Path.Combine(dir.FullName, "npc.yaml");

            // The public seam takes IMajorRecordGetter, not INpcGetter — proves the caller never
            // has to name the concrete type to serialize, only to deserialize back into one.
            await codec.SerializeAsync(original, filePath, GameRelease.Fallout4);
            var roundTripped = (Npc)await codec.DeserializeAsync(filePath, typeof(Npc), GameRelease.Fallout4);

            var mask = original.GetEqualsMask(roundTripped);
            var leaves = MaskInspector.CountLeaves(mask).ToList();
            var divergent = leaves.Where(l => !l.Value).Select(l => l.Path).ToList();

            Assert.NotEmpty(leaves);
            Assert.Empty(divergent);
        }
        finally
        {
            dir.Delete(recursive: true);
        }
    }

    [Fact]
    public async Task SerializeAsync_ThenDeserializeAsync_DispatchesCellByRuntimeType()
    {
        var codec = new RecordTextCodec(NullLogger<RecordTextCodec>.Instance);
        var original = MakeCell();
        var dir = Directory.CreateTempSubdirectory("medit-dispatch-cell-");
        try
        {
            var filePath = Path.Combine(dir.FullName, "cell.yaml");

            await codec.SerializeAsync(original, filePath, GameRelease.Fallout4);
            var roundTripped = (Cell)await codec.DeserializeAsync(filePath, typeof(Cell), GameRelease.Fallout4);

            var mask = original.GetEqualsMask(roundTripped);
            var leaves = MaskInspector.CountLeaves(mask).ToList();
            var divergent = leaves.Where(l => !l.Value).Select(l => l.Path).ToList();

            Assert.NotEmpty(leaves);
            Assert.Empty(divergent);
            // A childless Cell already emits one file with no shallow-copy intervention — Slice F
            // proves the strip is what keeps this true once children are populated.
            Assert.Equal([filePath], Directory.GetFiles(dir.FullName, "*", SearchOption.AllDirectories));
        }
        finally
        {
            dir.Delete(recursive: true);
        }
    }

    // The negative case Q asked for named explicitly: a type with no generated
    // <Type>_Serialization class must fail loud and actionable, not with a bare
    // NullReferenceException from a failed reflection lookup. IMajorRecordGetter itself is a real
    // Mutagen interface with no concrete "IMajorRecordGetter_Serialization" generated class — a
    // clean, always-true negative that needs no fixture and no seed-shape assumption.
    [Fact]
    public async Task SerializeAsync_UnsupportedRecordType_ThrowsNamedException()
    {
        var codec = new RecordTextCodec(NullLogger<RecordTextCodec>.Instance);
        var npc = MakeNpc();
        var dir = Directory.CreateTempSubdirectory("medit-dispatch-unsupported-");
        try
        {
            var filePath = Path.Combine(dir.FullName, "unsupported.yaml");
            await codec.SerializeAsync(npc, filePath, GameRelease.Fallout4);

            // The deserialize-by-type overload is where an unresolvable type is easiest to name
            // directly: IMajorRecordGetter is a real Mutagen interface with no generated
            // "IMajorRecordGetter_Serialization" class — a clean, always-true negative that needs
            // no fixture and no assumption about the generator's seed shape.
            var ex = await Assert.ThrowsAsync<RecordTypeSerializationUnsupportedException>(
                () => codec.DeserializeAsync(filePath, typeof(IMajorRecordGetter), GameRelease.Fallout4));

            Assert.Contains(nameof(IMajorRecordGetter), ex.Message, StringComparison.Ordinal);
            Assert.Contains("_Serialization", ex.Message, StringComparison.Ordinal);
        }
        finally
        {
            dir.Delete(recursive: true);
        }
    }
}
