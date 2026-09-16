using MEditService.Http;
using Microsoft.AspNetCore.Mvc.Testing;

namespace MEditService.Tests.Api;

/// <summary>The whole service, hosted in process. WebApplicationFactory reads only the assembly of
/// its type argument, and this assembly's own entry point is the internal Program no test may
/// see.</summary>
public sealed class MEditHost : WebApplicationFactory<PluginResponse>;
