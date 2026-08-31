using MEditService.Core.Serialization;
using MEditService.Tests.TestSupport;
using Microsoft.Extensions.Logging.Abstractions;
using Mutagen.Bethesda;
using Mutagen.Bethesda.Fallout4;
using Mutagen.Bethesda.Plugins;
using Mutagen.Bethesda.Plugins.Records;

namespace MEditService.Tests.Serialization;

/// <summary>
/// <see cref="RecordTextCodec"/>'s runtime record-type dispatch, proven at the
/// codec's own public seam rather than only through the one or two types an API-level fixture
/// happens to exercise (the mechanism generalizes to any of the ~586 generated
/// types via reflection on the generated class name — see RecordTextCodec's own doc comment).
///
/// Two positive types on purpose, not one: Npc (a plain record — the type the primary API
/// fixtures actually exercise) and Cell (a container-shaped type, built here with no
/// children populated so it stays one file regardless of shallow-vendoring policy — that policy is
/// <c>ContainerSingleFileTests</c>' concern, not dispatch's). Proving dispatch against two differently-shaped generated
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

    private static GlobalFloat MakeGlobalFloat() =>
        new(new FormKey(ModKey.FromFileName("Test.esp"), 0x902), Fallout4Release.Fallout4)
        {
            EditorID = "TestGlobal",
            Data = 1.5f,
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
            var roundTripped = (Npc)await codec.DeserializeAsync(filePath, GameRelease.Fallout4, "npc_");

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
            var roundTripped = (Cell)await codec.DeserializeAsync(filePath, GameRelease.Fallout4, "cell");

            var mask = original.GetEqualsMask(roundTripped);
            var leaves = MaskInspector.CountLeaves(mask).ToList();
            var divergent = leaves.Where(l => !l.Value).Select(l => l.Path).ToList();

            Assert.NotEmpty(leaves);
            Assert.Empty(divergent);
            // A childless Cell already emits one file with no shallow-copy intervention —
            // ContainerSingleFileTests proves the layout holds once children are populated.
            Assert.Equal([filePath], Directory.GetFiles(dir.FullName, "*", SearchOption.AllDirectories));
        }
        finally
        {
            dir.Delete(recursive: true);
        }
    }

    // The negative case, named explicitly: an unresolvable type must fail loud and
    // actionable, not with a bare NullReferenceException from a failed reflection lookup or the
    // generated dispatch's own anonymous NotImplementedException.
    //
    // A caller states record_type, not a CLR Type, and a record_type this game's
    // schema does not know is treated as "expect the document to name itself" rather than as a
    // dispatch target. The unresolvable-type failure is therefore a *document* naming a type the
    // dispatch has no case for — corrupt text, a hand-edited source file, or text written by a
    // future schema.
    //
    // The subject is a GlobalFloat rather than an Npc because only the
    // path-ambiguous types self-describe at all: an Npc document has no discriminator left to
    // corrupt, and GLOB — the type the discriminator exists for — does.
    [Fact]
    public async Task DeserializeAsync_ForTextNamingAnUnknownType_ThrowsNamedException()
    {
        var codec = new RecordTextCodec(NullLogger<RecordTextCodec>.Instance);
        var dir = Directory.CreateTempSubdirectory("medit-dispatch-unsupported-");
        try
        {
            var filePath = Path.Combine(dir.FullName, "unsupported.json");
            await codec.SerializeAsync(MakeGlobalFloat(), filePath, GameRelease.Fallout4);

            // Rewrite only the discriminator, leaving a structurally valid GlobalFloat document
            // behind it — so what fails is the type resolution and nothing else.
            var text = await File.ReadAllTextAsync(filePath);
            Assert.Contains("\"MutagenObjectType\": \"GlobalFloat\"", text, StringComparison.Ordinal);
            await File.WriteAllTextAsync(filePath,
                text.Replace("\"MutagenObjectType\": \"GlobalFloat\"", "\"MutagenObjectType\": \"NotARecordType\"", StringComparison.Ordinal));

            var ex = await Assert.ThrowsAsync<RecordTypeSerializationUnsupportedException>(
                () => codec.DeserializeAsync(filePath, GameRelease.Fallout4, "glob"));

            // The message says what went wrong, not merely that something did. The offending name
            // is deliberately not asserted: the kernel discards it on the route this case takes
            // (an unresolvable name yields a null Type, not a named one), so requiring it here
            // would pin an upstream detail rather than this codec's own contract.
            Assert.Contains("MutagenObjectType", ex.Message, StringComparison.Ordinal);
        }
        finally
        {
            dir.Delete(recursive: true);
        }
    }

    // The exception's own doc comment states it renders two distinct cases actionably: a missing
    // generated class entirely (covered above, via IMajorRecordGetter) and a generated class that
    // exists but lacks the expected static method — a generator shape change, a live failure mode
    // (Mutagen has changed behavior between point releases, and this codec sits
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
