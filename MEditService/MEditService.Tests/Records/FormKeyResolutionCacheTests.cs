using MEditService.Core.Records;

namespace MEditService.Tests.Records;

public class FormKeyResolutionCacheTests
{
    [Fact]
    public void Memoize_SameFormKeyResolvedTwice_UnderlyingResolverCalledOnce()
    {
        var calls = 0;
        Func<string, RecordLookupEntry?> inner = fk =>
        {
            calls++;
            return new RecordLookupEntry("kywd", "Good");
        };

        var memoized = FormKeyResolutionCache.Memoize(inner);
        memoized("000AAA:Test.esp");
        memoized("000AAA:Test.esp");

        Assert.Equal(1, calls);
    }

    [Fact]
    public void Memoize_DifferentFormKeys_ResolvedIndependently()
    {
        Func<string, RecordLookupEntry?> inner = fk =>
            fk == "000AAA:Test.esp" ? new RecordLookupEntry("kywd", "Good") : null;

        var memoized = FormKeyResolutionCache.Memoize(inner);

        Assert.NotNull(memoized("000AAA:Test.esp"));
        Assert.Null(memoized("000FFF:Test.esp"));
    }

    [Fact]
    public void Memoize_UnresolvedFormKey_CachesNullWithoutRequeryingUnderlying()
    {
        var calls = 0;
        Func<string, RecordLookupEntry?> inner = _ =>
        {
            calls++;
            return null;
        };

        var memoized = FormKeyResolutionCache.Memoize(inner);
        memoized("000FFF:Test.esp");
        memoized("000FFF:Test.esp");

        Assert.Equal(1, calls);
    }
}
