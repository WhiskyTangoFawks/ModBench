using System.Buffers.Binary;
using System.IO.Hashing;
using MEditService.TestSupport;
using Mutagen.Bethesda;
using Mutagen.Bethesda.Fallout4;
using Mutagen.Bethesda.Plugins;

namespace MEditService.PluginAdapter.Tests.PluginAdapter;

public sealed class PluginOriginalHashesTests : IDisposable
{
    private static readonly Dictionary<string, bool> SmallSet = new() { ["Small"] = true };

    private readonly ScratchDirectory _scratch = new("plugin-original-hashes-");

    public void Dispose() => _scratch.Dispose();

    private string Written(string fileName, Action<Fallout4Mod> shape) => Written(_scratch, fileName, shape);

    private static string Written(string folder, string fileName, Action<Fallout4Mod> shape)
    {
        var path = Path.Combine(folder, fileName);
        var mod = new Fallout4Mod(ModKey.FromFileName(fileName), Fallout4Release.Fallout4);
        shape(mod);
        mod.WriteToBinary(path);
        return path;
    }

    private static string WrittenAt(string path, byte[] bytes)
    {
        File.WriteAllBytes(path, bytes);
        return path;
    }

    private static string HashOf(string path)
    {
        Span<byte> digest = stackalloc byte[sizeof(ulong)];
        BinaryPrimitives.WriteUInt64LittleEndian(digest, XxHash64.HashToUInt64(File.ReadAllBytes(path)));
        return Convert.ToBase64String(digest);
    }

    private static IReadOnlyList<string> Of(string path, Dictionary<string, bool> flags) =>
        PluginOriginalHashes.Of(path, flags, GameRelease.Fallout4).Answered();

    [Fact]
    public void AFileWithTheFlagsSet_AnswersTheHashOfItWithTheFlagAsItWasAndAsItWasNot()
    {
        var plain = Written("Plain.esp", _ => { });
        var small = Written("Small.esp", mod => mod.IsSmallMaster = true);

        Assert.Equal(new[] { HashOf(plain), HashOf(small) }.Order(), Of(small, SmallSet).Order());
    }

    [Fact]
    public void NamingTwoFlags_AnswersEachCombinationOfTheirOriginals()
    {
        var both = Written("Both.esp", mod => { mod.IsSmallMaster = true; mod.IsMaster = true; });
        var masterOnly = Written("Master.esp", mod => mod.IsMaster = true);
        var smallOnly = Written("SmallOnly.esp", mod => mod.IsSmallMaster = true);
        var neither = Written("Neither.esp", _ => { });

        var hashes = Of(both, new Dictionary<string, bool> { ["Small"] = true, ["Master"] = true });

        Assert.Equal(new[] { HashOf(both), HashOf(masterOnly), HashOf(smallOnly), HashOf(neither) }.Order(), hashes.Order());
    }

    [Fact]
    public void AskingForTheHashes_WritesNothing()
    {
        var small = Written("Small.esp", mod => mod.IsSmallMaster = true);
        var before = File.ReadAllBytes(small);

        Of(small, SmallSet);

        Assert.Equal(before, File.ReadAllBytes(small));
        Assert.Equal(["Small.esp"], Directory.GetFiles(_scratch).Select(Path.GetFileName));
    }

    public static TheoryData<string, Func<string, string>> WithNoOriginal => new()
    {
        { "a plugin without the flags the manifest sets", folder => Written(folder, "Plain.esp", _ => { }) },
        { "a file that is no plugin", folder => WrittenAt(Path.Combine(folder, "Not.esp"), new byte[64]) },
        { "a file shorter than a record header", folder => WrittenAt(Path.Combine(folder, "Short.esp"), new byte[3]) },
    };

    [Theory]
    [MemberData(nameof(WithNoOriginal))]
    public void AFileThatCouldNotHaveHeldACopyWithTheFlags_HasNoOriginalHash(string _, Func<string, string> fileIn)
    {
        Assert.Empty(Of(fileIn(_scratch), SmallSet));
    }

    [Fact]
    public void AFileThatCannotBeRead_IsAFailure() =>
        Assert.IsType<PluginFailure.Inaccessible>(PluginOriginalHashes.Of(Path.Combine(_scratch, "Gone.esp"), SmallSet, GameRelease.Fallout4).Failure());
}
