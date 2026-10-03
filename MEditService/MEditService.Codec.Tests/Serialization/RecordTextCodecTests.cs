using MEditService.Codec.Serialization;
using MEditService.Codec.Tests.TestSupport;
using MEditService.TestSupport;
using Microsoft.Extensions.Logging.Abstractions;
using Mutagen.Bethesda;
using Mutagen.Bethesda.Fallout4;
using Mutagen.Bethesda.Plugins;
using Noggog;

namespace MEditService.Codec.Tests.Serialization;

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

    [Fact]
    public async Task SerializeAsync_ThenDeserializeFile_IsFieldFaithful_BecauseTheOmitCustomizationsAreVerifiedNoOpsForAStandaloneWeaponBothTargetingOnlyGroupCellWorldspaceFieldsItDoesNotHave()
    {
        var codec = new RecordTextCodec(NullLogger<RecordTextCodec>.Instance);
        var original = MakeWeapon();
        using var dir = new ScratchDirectory("medit-codec-fidelity-");
        var filePath = Path.Combine(dir.Path, "weapon.json");
        await codec.SerializeAsync(original, filePath, GameRelease.Fallout4);

        var roundTripped = (Weapon)codec.DeserializeFile(filePath, GameRelease.Fallout4, "weap");

        var mask = original.GetEqualsMask(roundTripped);
        var leaves = MaskInspector.CountLeaves(mask).ToList();
        var divergent = leaves.Where(l => !l.Value).Select(l => l.Path).ToList();

        Assert.Equal(81, leaves.Count);
        Assert.Empty(divergent);
    }

    [Fact]
    public async Task SerializeAsync_WritesOneFileAtTheGivenPath()
    {
        var codec = new RecordTextCodec(NullLogger<RecordTextCodec>.Instance);
        var weapon = MakeWeapon();
        using var dir = new ScratchDirectory("medit-codec-layout-");
        var filePath = Path.Combine(dir.Path, "weapon.json");

        await codec.SerializeAsync(weapon, filePath, GameRelease.Fallout4);

        Assert.True(File.Exists(filePath));
        Assert.Equal([filePath], Directory.GetFiles(dir.Path, "*", SearchOption.AllDirectories));
    }

    [Fact]
    public async Task SerializeAsync_ForAFixedWeapon_MatchesThePinnedGoldenTextExactly_AStandingGateForTheDispatchBeingBehaviorPreservingForWeaponRegeneratedOnlyAfterReVerifyingThatClaim()
    {
        var codec = new RecordTextCodec(NullLogger<RecordTextCodec>.Instance);
        using var dir = new ScratchDirectory("medit-codec-golden-");
        var filePath = Path.Combine(dir.Path, "weapon.json");
        await codec.SerializeAsync(MakeWeapon(), filePath, GameRelease.Fallout4);

        var actual = await File.ReadAllTextAsync(filePath);
        var golden = await File.ReadAllTextAsync(Path.Combine(AppContext.BaseDirectory, "TestData", "weapon-dispatch-golden.json"));

        Assert.Equal(golden, actual);
    }

    [Fact]
    public async Task SerializeAsync_CalledTwiceOnTheSameRecordState_ProducesByteIdenticalOutput_WithNoGoldenInTheLoopBecauseAGoldenIsBlindToNonDeterminismThatReproducesTheSameWrongOutputEveryRun()
    {
        var codec = new RecordTextCodec(NullLogger<RecordTextCodec>.Instance);
        using var dir = new ScratchDirectory("medit-codec-determinism-");
        var firstPath = Path.Combine(dir.Path, "weapon-first.json");
        var secondPath = Path.Combine(dir.Path, "weapon-second.json");

        var firstWeapon = MakeWeapon();
        var independentlyConstructedSecondWeaponSoAPerInstanceMemoizerCannotTriviallyAgreeWithItself = MakeWeapon();
        await codec.SerializeAsync(firstWeapon, firstPath, GameRelease.Fallout4);
        await codec.SerializeAsync(independentlyConstructedSecondWeaponSoAPerInstanceMemoizerCannotTriviallyAgreeWithItself, secondPath, GameRelease.Fallout4);

        var firstBytes = await File.ReadAllBytesAsync(firstPath);
        var secondBytes = await File.ReadAllBytesAsync(secondPath);

        Assert.Equal(firstBytes, secondBytes);
    }

    [Fact]
    public async Task SerializeAsync_NeverEmitsACarriageReturn_BecauseTheJsonKernelIndentsFromItsPrivateInnerTextWritersNewLineWhichTheCodecCannotConfigureSoItNormalizesAfter()
    {
        var codec = new RecordTextCodec(NullLogger<RecordTextCodec>.Instance);
        using var dir = new ScratchDirectory("medit-codec-no-cr-");
        var filePath = Path.Combine(dir.Path, "weapon.json");
        await codec.SerializeAsync(MakeWeapon(), filePath, GameRelease.Fallout4);

        var bytes = await File.ReadAllBytesAsync(filePath);

        Assert.DoesNotContain((byte)'\r', bytes);
    }

    [Fact]
    public async Task SerializeAsync_WhenTheWriteFailsBeforeTheRename_LeavesThePreexistingFileIntact_InjectedViaDevFullBecauseAPreCancelledTokenThrowsIdenticallyUnderEitherImplementationSinceCancellationIsCheckedBeforeAnyFileIsTouched()
    {
        var codec = new RecordTextCodec(NullLogger<RecordTextCodec>.Instance);
        using var dir = new ScratchDirectory("medit-codec-atomicity-");
        var filePath = Path.Combine(dir.Path, "weapon.json");
        var originalBytes = "{\"original\":\"content\"}\n"u8.ToArray();
        await File.WriteAllBytesAsync(filePath, originalBytes);

        File.CreateSymbolicLink(filePath + ".tmp", "/dev/full");

        await Assert.ThrowsAnyAsync<IOException>(
            () => codec.SerializeAsync(MakeWeapon(), filePath, GameRelease.Fallout4));

        var survivingBytes = await File.ReadAllBytesAsync(filePath);
        Assert.Equal(originalBytes, survivingBytes);
    }
}
