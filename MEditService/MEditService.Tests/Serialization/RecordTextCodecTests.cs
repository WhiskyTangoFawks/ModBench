using MEditService.Core.Serialization;
using MEditService.Tests.TestSupport;
using Microsoft.Extensions.Logging.Abstractions;
using Mutagen.Bethesda;
using Mutagen.Bethesda.Fallout4;
using Mutagen.Bethesda.Plugins;
using Noggog;

namespace MEditService.Tests.Serialization;

public class RecordTextCodecTests
{
    private static Weapon MakeWeapon() =>
        new(new FormKey(ModKey.FromFileName("Test.esp"), 0x800), Fallout4Release.Fallout4)
        {
            VersionControl = 12345,
            EditorID = "TestWeapon",
            Name = "Test Weapon Name",
            Value = 250,
            Weight = 12.5f,
            BaseDamage = 42,
            Keywords = [new FormLink<IKeywordGetter>(new FormKey(ModKey.FromFileName("Test.esp"), 0x801))],
            ObjectBounds = new ObjectBounds
            {
                First = new P3Int16(1, 2, 3),
                Second = new P3Int16(4, 5, 6),
            },
        };

    // No exclusion list: verified empirically (#367 report) that .OmitLastModifiedData()/
    // .OmitTimestampData() are no-ops for a standalone Weapon — the serialized YAML is
    // byte-identical with and without them. Both customizations are about mod/header-level
    // metadata (Spriggit's own scope), which this codec never touches; VersionControl (the field
    // that could plausibly be "the timestamp" on a record) round-trips like everything else, which
    // is why this test asserts every field equal with no exceptions.
    //
    // The leaf-count guard is load-bearing, not decoration: Assert.Empty(divergent) alone passes
    // if the walker visits zero leaves (a broken walker, a mask that came back null-shaped, etc.)
    // just as happily as it passes on genuine equality — the same structural blindness
    // BinaryRoundTripGateTests was written to avoid. 81 is the measured leaf count for MakeWeapon();
    // a future Mutagen bump changing that number is itself worth seeing, not just silently accepted.
    [Fact]
    public async Task SerializeAsync_ThenDeserializeAsync_IsFieldFaithful()
    {
        var codec = new RecordTextCodec(NullLogger<RecordTextCodec>.Instance);
        var original = MakeWeapon();
        var dir = Directory.CreateTempSubdirectory("medit-codec-fidelity-");
        try
        {
            var filePath = Path.Combine(dir.FullName, "weapon.yaml");
            await codec.SerializeAsync(original, filePath, GameRelease.Fallout4);

            var roundTripped = await codec.DeserializeAsync(filePath, GameRelease.Fallout4);

            var mask = original.GetEqualsMask(roundTripped);
            var leaves = MaskInspector.CountLeaves(mask).ToList();
            var divergent = leaves.Where(l => !l.Value).Select(l => l.Path).ToList();

            Assert.Equal(81, leaves.Count);
            Assert.Empty(divergent);
        }
        finally
        {
            dir.Delete(recursive: true);
        }
    }

    [Fact]
    public async Task SerializeAsync_WritesOneFileAtTheGivenPath()
    {
        var codec = new RecordTextCodec(NullLogger<RecordTextCodec>.Instance);
        var weapon = MakeWeapon();
        var dir = Directory.CreateTempSubdirectory("medit-codec-layout-");
        try
        {
            var filePath = Path.Combine(dir.FullName, "weapon.yaml");

            await codec.SerializeAsync(weapon, filePath, GameRelease.Fallout4);

            Assert.True(File.Exists(filePath));
            Assert.Equal([filePath], Directory.GetFiles(dir.FullName, "*", SearchOption.AllDirectories));
        }
        finally
        {
            dir.Delete(recursive: true);
        }
    }
}
