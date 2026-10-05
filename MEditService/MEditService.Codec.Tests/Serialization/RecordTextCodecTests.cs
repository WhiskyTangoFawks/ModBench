using System.Text;
using MEditService.Codec.Serialization;
using MEditService.Codec.Tests.TestSupport;
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
    public void SerializeToBytes_ThenDeserializeFromBytes_IsFieldFaithful_BecauseTheOmitCustomizationsAreVerifiedNoOpsForAStandaloneWeaponBothTargetingOnlyGroupCellWorldspaceFieldsItDoesNotHave()
    {
        var codec = Codec();
        var original = MakeWeapon();
        var bytes = codec.SerializeToBytes(original, GameRelease.Fallout4);

        var roundTripped = (Weapon)codec.DeserializeFromBytes(bytes, GameRelease.Fallout4, "weap");

        var mask = original.GetEqualsMask(roundTripped);
        var leaves = MaskInspector.CountLeaves(mask).ToList();
        var divergent = leaves.Where(l => !l.Value).Select(l => l.Path).ToList();

        Assert.Equal(81, leaves.Count);
        Assert.Empty(divergent);
    }

    [Fact]
    public async Task SerializeToBytes_ForAFixedWeapon_MatchesThePinnedGoldenTextExactly_AStandingGateForTheDispatchBeingBehaviorPreservingForWeaponRegeneratedOnlyAfterReVerifyingThatClaim()
    {
        var actual = Encoding.UTF8.GetString(Codec().SerializeToBytes(MakeWeapon(), GameRelease.Fallout4));
        var golden = await File.ReadAllTextAsync(Path.Combine(AppContext.BaseDirectory, "TestData", "weapon-dispatch-golden.json"));

        Assert.Equal(golden, actual);
    }

    [Fact]
    public void SerializeToBytes_CalledTwiceOnTheSameRecordState_ProducesByteIdenticalOutput_WithNoGoldenInTheLoopBecauseAGoldenIsBlindToNonDeterminismThatReproducesTheSameWrongOutputEveryRun()
    {
        var codec = Codec();
        var independentlyConstructedSecondWeaponSoAPerInstanceMemoizerCannotTriviallyAgreeWithItself = MakeWeapon();

        var firstBytes = codec.SerializeToBytes(MakeWeapon(), GameRelease.Fallout4);
        var secondBytes = codec.SerializeToBytes(independentlyConstructedSecondWeaponSoAPerInstanceMemoizerCannotTriviallyAgreeWithItself, GameRelease.Fallout4);

        Assert.Equal(firstBytes, secondBytes);
    }

    [Fact]
    public void SerializeToBytes_NeverEmitsACarriageReturn_BecauseTheJsonKernelIndentsFromItsPrivateInnerTextWritersNewLineWhichTheCodecCannotConfigureSoItNormalizesAfter()
    {
        var bytes = Codec().SerializeToBytes(MakeWeapon(), GameRelease.Fallout4);

        Assert.DoesNotContain((byte)'\r', bytes);
    }

    private static RecordTextCodec Codec() => new(NullLogger<RecordTextCodec>.Instance);
}
