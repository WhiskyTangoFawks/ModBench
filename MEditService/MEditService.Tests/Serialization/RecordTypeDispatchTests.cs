using MEditService.Core.Serialization;
using MEditService.Tests.TestSupport;
using Microsoft.Extensions.Logging.Abstractions;
using Mutagen.Bethesda;
using Mutagen.Bethesda.Fallout4;
using Mutagen.Bethesda.Plugins;
using Mutagen.Bethesda.Plugins.Records;

namespace MEditService.Tests.Serialization;

/// <summary>Two positive types on purpose: Npc and a childless Cell, differently shaped generated
/// classes, which is what distinguishes "resolves for the one type tried" from "resolves by a
/// naming convention that holds".</summary>
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

    // An unresolvable type must fail loud and actionable, not with a bare NullReferenceException. A
    // record_type the schema does not know means "expect the document to name itself", so the failure
    // is a document naming a type with no case.
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

            // The offending name is deliberately not asserted: the kernel discards it on this route, so
            // requiring it would pin an upstream detail rather than this codec's contract.
            Assert.Contains("MutagenObjectType", ex.Message, StringComparison.Ordinal);
        }
        finally
        {
            dir.Delete(recursive: true);
        }
    }

    // The second case, a generated class missing the expected static method, has no real fixture to
    // drive it, so the exception is constructed directly. Mutagen has changed generator shape between
    // point releases, so it is a live failure mode.
    [Fact]
    public void UnsupportedException_WhenTheGeneratedTypeExistsButLacksTheMethod_NamesBothInTheMessage()
    {
        var ex = new RecordTypeSerializationUnsupportedException(typeof(Npc), typeof(object), "Serialize");

        Assert.Contains(typeof(object).FullName!, ex.Message, StringComparison.Ordinal);
        Assert.Contains("Serialize", ex.Message, StringComparison.Ordinal);
    }
}
