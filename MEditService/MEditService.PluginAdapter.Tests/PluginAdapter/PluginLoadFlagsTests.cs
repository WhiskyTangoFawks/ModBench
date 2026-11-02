using System.Buffers.Binary;
using System.IO.Hashing;
using MEditService.TestSupport;
using Mutagen.Bethesda;
using Mutagen.Bethesda.Fallout4;
using Mutagen.Bethesda.Plugins;

namespace MEditService.PluginAdapter.Tests.PluginAdapter;

public sealed class PluginLoadFlagsTests : IDisposable
{
    private static readonly IPluginAdapter Adapter = TestAdapters.Mutagen();

    private readonly ScratchDirectory _scratch = new("plugin-load-flags-");

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
    public void SettingAFlag_ChangesNoOtherByte_AndAnswersTheHashItWrote()
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
    public void AWrite_LeavesNoTempBesideThePlugin()
    {
        var plain = Written("Plain.esp", _ => { });

        Adapter.SetLoadFlags(plain, new Dictionary<string, bool> { ["Master"] = true }, GameRelease.Fallout4).Answered();

        Assert.Equal(["Plain.esp"], Directory.GetFiles(_scratch).Select(Path.GetFileName));
    }

    [Fact]
    public void AFileThatIsNoPlugin_IsAFailure_AndLeftAsItWas()
    {
        var path = Path.Combine(_scratch, "Not.esp");
        File.WriteAllBytes(path, new byte[64]);

        Assert.IsType<PluginFailure.Unparsed>(Adapter.SetLoadFlags(path, new Dictionary<string, bool> { ["Small"] = true }, GameRelease.Fallout4).Failure());
        Assert.Equal(new byte[64], File.ReadAllBytes(path));
    }
}
