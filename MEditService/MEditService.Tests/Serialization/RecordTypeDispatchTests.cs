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
/// fixtures actually exercise) and Cell (a container-shaped type, built here with no
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
            var filePath = Path.Combine(dir.FullName, "npc.json");

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
            var filePath = Path.Combine(dir.FullName, "cell.json");

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
            var filePath = Path.Combine(dir.FullName, "unsupported.json");
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

    // The exception's own doc comment states it renders two distinct cases actionably: a missing
    // generated class entirely (covered above, via IMajorRecordGetter) and a generated class that
    // exists but lacks the expected static method — a generator shape change, the live failure mode
    // #385 exists because of (Mutagen changed behavior between point releases, and this codec sits
    // directly on that generator's output shape). The second case has no real-world fixture to drive
    // it through RecordTextCodec itself (it would require a generated type that is missing exactly
    // one method, which nothing in this assembly's schema naturally is), so this constructs the
    // exception directly through its internal (Type, Type?, string?) constructor — reachable from
    // this project via the same InternalsVisibleTo(MEditService.Tests) seam GitCliTests already
    // uses — and asserts the message names both the generated type and the missing method, the way
    // a developer reading a real generator-shape-change failure would need it to.
    [Fact]
    public void UnsupportedException_WhenTheGeneratedTypeExistsButLacksTheMethod_NamesBothInTheMessage()
    {
        var ex = new RecordTypeSerializationUnsupportedException(typeof(Npc), typeof(object), "Serialize");

        Assert.Contains(typeof(object).FullName!, ex.Message, StringComparison.Ordinal);
        Assert.Contains("Serialize", ex.Message, StringComparison.Ordinal);
    }
}
