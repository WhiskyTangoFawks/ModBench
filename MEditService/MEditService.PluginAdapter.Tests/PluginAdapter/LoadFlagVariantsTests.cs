using System.Buffers.Binary;
using System.IO.Hashing;
using MEditService.TestSupport;
using Mutagen.Bethesda;
using Mutagen.Bethesda.Fallout4;
using Mutagen.Bethesda.Plugins;

namespace MEditService.PluginAdapter.Tests.PluginAdapter;

public sealed class LoadFlagVariantsTests : IDisposable
{
    private static readonly IPluginAdapter Adapter = TestAdapters.Mutagen();

    private readonly ScratchDirectory _scratch = new("load-flag-variants-");

    public void Dispose() => _scratch.Dispose();

    private string Written(string fileName, Action<Fallout4Mod> shape)
    {
        var path = Path.Combine(_scratch, fileName);
        var mod = new Fallout4Mod(ModKey.FromFileName(fileName), Fallout4Release.Fallout4);
        shape(mod);
        mod.WriteToBinary(path);
        return path;
    }

    private static string HashOf(string path)
    {
        Span<byte> digest = stackalloc byte[sizeof(ulong)];
        BinaryPrimitives.WriteUInt64LittleEndian(digest, XxHash64.HashToUInt64(File.ReadAllBytes(path)));
        return Convert.ToBase64String(digest);
    }

    [Fact]
    public void EachVariant_HashesAsTheSamePluginWrittenWithThoseFlags()
    {
        var plain = Written("Plain.esp", _ => { });
        var small = Written("Small.esp", mod => mod.IsSmallMaster = true);
        var master = Written("Master.esp", mod => mod.IsMaster = true);

        var variants = Adapter.FlagVariantsOf(plain, GameRelease.Fallout4).Answered();

        Assert.Contains(variants, variant => variant.Flags.SequenceEqual(new Dictionary<string, bool> { ["Small"] = true }) && variant.Hash == HashOf(small));
        Assert.Contains(variants, variant => variant.Flags.SequenceEqual(new Dictionary<string, bool> { ["Master"] = true }) && variant.Hash == HashOf(master));
    }

    [Fact]
    public void TheVariants_NameFlippedFlagsByTheValuesTheyThenHold_FewestFlipsFirst()
    {
        var small = Written("Small.esp", mod => mod.IsSmallMaster = true);

        var variants = Adapter.FlagVariantsOf(small, GameRelease.Fallout4).Answered();

        Assert.Equal(
            ["Master=True", "Small=False", "Master=True,Small=False"],
            variants.Select(variant => string.Join(",", variant.Flags.OrderBy(flag => flag.Key).Select(flag => $"{flag.Key}={flag.Value}"))));
    }

    [Fact]
    public void SettingFlags_ChangesNoOtherByte_AndAnswersTheHashItWrote()
    {
        var plain = Written("Plain.esp", _ => { });
        var small = Written("Small.esp", mod => mod.IsSmallMaster = true);

        var written = Adapter.SetLoadFlags(plain, new Dictionary<string, bool> { ["Small"] = true }, GameRelease.Fallout4).Answered();

        Assert.Equal(File.ReadAllBytes(small), File.ReadAllBytes(plain));
        Assert.Equal(HashOf(small), written);
    }

    [Fact]
    public void SettingAFlagToFalse_ClearsIt()
    {
        var small = Written("Small.esp", mod => mod.IsSmallMaster = true);
        var plain = Written("Plain.esp", _ => { });

        Adapter.SetLoadFlags(small, new Dictionary<string, bool> { ["Small"] = false }, GameRelease.Fallout4).Answered();

        Assert.Equal(File.ReadAllBytes(plain), File.ReadAllBytes(small));
    }

    [Fact]
    public void AFileThatIsNoPlugin_IsAFailure()
    {
        var path = Path.Combine(_scratch, "Not.esp");
        File.WriteAllBytes(path, new byte[64]);

        Assert.IsType<PluginFailure.Unparsed>(Adapter.FlagVariantsOf(path, GameRelease.Fallout4).Failure());
    }
}
