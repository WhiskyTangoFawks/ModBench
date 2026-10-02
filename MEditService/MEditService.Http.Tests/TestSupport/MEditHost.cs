using Microsoft.AspNetCore.Hosting;
using Microsoft.AspNetCore.Mvc.Testing;
using Microsoft.AspNetCore.TestHost;
using Serilog;
using Serilog.Core;

namespace MEditService.Http.Tests.TestSupport;

/// <summary>The whole service, hosted in process, logging nowhere: the service's logger writes to
/// the user's log folder, and it freezes the process's one Serilog bootstrap logger, so a second
/// host starting beside it fails.</summary>
public sealed class MEditHost : WebApplicationFactory<Program>
{
    protected override void ConfigureWebHost(IWebHostBuilder builder) =>
        builder.ConfigureTestServices(services => services.AddSerilog(Logger.None));
}
